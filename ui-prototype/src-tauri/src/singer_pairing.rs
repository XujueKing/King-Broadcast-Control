use super::*;
use hmac::{Hmac, Mac};
use sha2::Sha256;

pub(super) struct PairingWindow {
    code: String,
    opened: Instant,
    expires_at: u64,
    failures: u8,
}
impl PairingWindow {
    pub(super) fn status(&self) -> Value {
        let active = self.opened.elapsed() < Duration::from_secs(300) && self.failures < 5;
        json!({"active":active,"code":if active {Some(&self.code)} else {None},"expiresAtUnixMs":self.expires_at,"locked":self.failures>=5})
    }
}
pub(super) fn set_window(gateway: &SingerGateway, enabled: bool) -> Result<(), String> {
    let mut inner = gateway.0.inner.lock().unwrap();
    if enabled && (!inner.config.enabled || !inner.running) { return Err("请先开启主唱接口".into()); }
    inner.pairing = if enabled {
        // UUID v4's first 16 bits are random; rejection avoids modulo bias.
        let code = loop {
            let bytes = *uuid::Uuid::new_v4().as_bytes();
            let n = u16::from_be_bytes([bytes[0], bytes[1]]);
            if n < 60000 { break format!("{:04}", n % 10000); }
        };
        Some(PairingWindow { code, opened: Instant::now(), expires_at: now_ms()+300_000, failures: 0 })
    } else { None };
    Ok(())
}
#[derive(Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub(super) struct PairRequest { controller_id: String, code: String }
pub(super) async fn pair(State(gateway): State<SingerGateway>, Json(request): Json<PairRequest>) -> Result<Json<Value>, ApiError> {
    let mut inner = gateway.0.inner.lock().unwrap();
    if !inner.config.enabled || !inner.running { return Err(ApiError(StatusCode::SERVICE_UNAVAILABLE,"pairing_closed")); }
    if request.controller_id != inner.config.controller_id { return Err(ApiError(StatusCode::CONFLICT,"controller_changed")); }
    let window = inner.pairing.as_mut().ok_or(ApiError(StatusCode::FORBIDDEN,"pairing_closed"))?;
    if window.failures >= 5 { return Err(ApiError(StatusCode::TOO_MANY_REQUESTS,"pairing_locked")); }
    if window.opened.elapsed() >= Duration::from_secs(300) { return Err(ApiError(StatusCode::GONE,"pairing_expired")); }
    if request.code.len()!=4 || !request.code.bytes().all(|b| b.is_ascii_digit()) || request.code.bytes().zip(window.code.bytes()).fold(0u8,|d,(a,b)|d|(a^b))!=0 {
        window.failures += 1;
        return Err(ApiError(StatusCode::UNAUTHORIZED,"invalid_pairing_code"));
    }
    inner.pairing = None;
    Ok(Json(json!({"apiVersion":1,"controllerId":inner.config.controller_id,"token":inner.config.token})))
}

fn discovery_response(gateway: &SingerGateway, packet: &[u8]) -> Option<Vec<u8>> {
    let value: Value = serde_json::from_slice(packet).ok()?;
    if value.get("service")?.as_str()? != "kingclub-singer-discover-v1" { return None; }
    let nonce = value.get("nonce")?.as_str()?;
    if nonce.len()!=32 || !nonce.bytes().all(|b|b.is_ascii_hexdigit()) { return None; }
    let inner = gateway.0.inner.lock().unwrap();
    if !inner.config.enabled || !inner.running { return None; }
    let message = format!("kingclub-singer-v1|{}|{}|{}",nonce,inner.config.controller_id,inner.config.port);
    let mut mac = Hmac::<Sha256>::new_from_slice(inner.config.token.as_bytes()).ok()?;
    mac.update(message.as_bytes());
    let proof = mac.finalize().into_bytes().iter().map(|b|format!("{b:02x}")).collect::<String>();
    serde_json::to_vec(&json!({"service":"kingclub-singer-v1","apiVersion":1,"nonce":nonce,
        "controllerId":inner.config.controller_id,"name":"KINGCLUB 中控","port":inner.config.port,"proof":proof})).ok()
}
#[derive(Deserialize)]
pub(super) struct InfoQuery { nonce: String }
pub(super) async fn info(State(gateway): State<SingerGateway>, Query(query): Query<InfoQuery>) -> Result<Json<Value>, ApiError> {
    let packet=serde_json::to_vec(&json!({"service":"kingclub-singer-discover-v1","nonce":query.nonce})).unwrap();
    let response=discovery_response(&gateway,&packet).ok_or(ApiError(StatusCode::BAD_REQUEST,"discovery_unavailable"))?;
    Ok(Json(serde_json::from_slice(&response).unwrap()))
}
pub(super) async fn start_discovery(gateway: &SingerGateway) {
    // Fixed discovery port is independent of the configurable HTTP port.
    let socket = match tokio::net::UdpSocket::bind("0.0.0.0:4866").await {
        Ok(socket)=>socket,
        Err(error)=>{ gateway.0.inner.lock().unwrap().error=Some(format!("自动发现不可用，可手动填写地址：{error}")); return; }
    };
    let gateway_copy = gateway.clone();
    let task = tokio::spawn(async move {
        let mut packet=[0u8;512];
        let mut last = Instant::now()-Duration::from_secs(1);
        loop {
            let Ok((size,peer)) = socket.recv_from(&mut packet).await else { break; };
            if !matches!(peer.ip(),IpAddr::V4(ip) if ip.is_private() || ip.is_loopback()) || last.elapsed()<Duration::from_millis(100) {continue;}
            if let Some(reply)=discovery_response(&gateway_copy,&packet[..size]) {
                last=Instant::now();
                let _=socket.send_to(&reply,peer).await;
            }
        }
    });
    *gateway.0.discovery.lock().unwrap()=Some(task);
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use tower::ServiceExt;
    fn gateway() -> SingerGateway { let g=SingerGateway::default(); {let mut i=g.0.inner.lock().unwrap();i.running=true;i.config.enabled=true;} g }
    #[tokio::test]
    async fn short_code_is_one_use_and_limited_across_peers() {
        let g=gateway();set_window(&g,true).unwrap();
        let id=g.0.inner.lock().unwrap().config.controller_id.clone();
        let code=g.0.inner.lock().unwrap().pairing.as_ref().unwrap().code.clone();
        let wrong=if code=="0000" {"0001"} else {"0000"};
        for _ in 0..5 {assert_eq!(pair(State(g.clone()),Json(PairRequest{controller_id:id.clone(),code:wrong.into()})).await.unwrap_err().0,StatusCode::UNAUTHORIZED);}
        assert_eq!(pair(State(g.clone()),Json(PairRequest{controller_id:id.clone(),code:code.clone()})).await.unwrap_err().0,StatusCode::TOO_MANY_REQUESTS);
        set_window(&g,true).unwrap();let code=g.0.inner.lock().unwrap().pairing.as_ref().unwrap().code.clone();
        assert!(pair(State(g.clone()),Json(PairRequest{controller_id:id.clone(),code:code.clone()})).await.is_ok());
        assert!(pair(State(g.clone()),Json(PairRequest{controller_id:id,code})).await.is_err());
    }
    #[tokio::test]
    async fn pairing_expiry_disable_and_origin_are_enforced() {
        let g=gateway();set_window(&g,true).unwrap();
        let id=g.0.inner.lock().unwrap().config.controller_id.clone();
        g.0.inner.lock().unwrap().pairing.as_mut().unwrap().opened=Instant::now()-Duration::from_secs(301);
        assert_eq!(pair(State(g.clone()),Json(PairRequest{controller_id:id,code:"0000".into()})).await.unwrap_err().0,StatusCode::GONE);
        let req=axum::http::Request::builder().method("POST").uri("/api/singer/v1/pair").header("Origin","http://evil.test").extension(ConnectInfo("192.168.1.10:5000".parse::<SocketAddr>().unwrap())).body(Body::from("{}")).unwrap();
        assert_eq!(router(g.clone()).oneshot(req).await.unwrap().status(),StatusCode::FORBIDDEN);
        g.0.inner.lock().unwrap().config.enabled=false;
        assert!(set_window(&g,true).is_err());
    }
    #[test]
    fn discovery_never_exposes_credentials_and_binds_proof_to_nonce_identity_port() {
        let g=gateway();let nonce="0".repeat(32);let packet=serde_json::to_vec(&json!({"service":"kingclub-singer-discover-v1","nonce":nonce})).unwrap();
        let response:Value=serde_json::from_slice(&discovery_response(&g,&packet).unwrap()).unwrap();
        assert!(response.get("token").is_none());assert!(response.get("code").is_none());
        let i=g.0.inner.lock().unwrap();let mut mac=Hmac::<Sha256>::new_from_slice(i.config.token.as_bytes()).unwrap();
        mac.update(format!("kingclub-singer-v1|{}|{}|{}",nonce,i.config.controller_id,i.config.port).as_bytes());
        let expected=mac.finalize().into_bytes().iter().map(|b|format!("{b:02x}")).collect::<String>();
        assert_eq!(response["proof"],expected);drop(i);
        assert!(discovery_response(&g,b"{}").is_none());
        g.0.inner.lock().unwrap().running=false;assert!(discovery_response(&g,&packet).is_none());
    }
}
