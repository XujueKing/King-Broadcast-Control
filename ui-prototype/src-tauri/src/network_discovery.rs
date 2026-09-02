use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream, ToSocketAddrs},
    sync::{
        atomic::{AtomicU16, Ordering},
        Mutex,
    },
    thread,
    time::Duration,
};

const DISCOVERY_WORKERS: usize = 32;

fn resolve_ipv4_hint(host_hint: &str, port: u16) -> Result<Ipv4Addr, String> {
    let hint = host_hint.trim();
    if hint.is_empty() {
        return Err("自动扫描需要一个已保存的局域网地址".to_string());
    }
    if let Ok(address) = hint.parse::<Ipv4Addr>() {
        return Ok(address);
    }
    (hint, port)
        .to_socket_addrs()
        .map_err(|error| format!("无法解析已保存地址 {hint}：{error}"))?
        .find_map(|address| match address.ip() {
            IpAddr::V4(address) => Some(address),
            IpAddr::V6(_) => None,
        })
        .ok_or_else(|| format!("{hint} 未解析到可扫描的 IPv4 地址"))
}

fn subnet_candidate(prefix: [u8; 3], host: u8) -> Ipv4Addr {
    Ipv4Addr::new(prefix[0], prefix[1], prefix[2], host)
}

/// Scan only the /24 containing the last known address. This is deliberately
/// bounded: it never walks other VLANs and is only called after a saved target
/// has failed, so it cannot compete with a live Qu-16 control session.
pub fn scan_tcp_subnet(
    host_hint: &str,
    port: u16,
    timeout: Duration,
) -> Result<Vec<String>, String> {
    let hint = resolve_ipv4_hint(host_hint, port)?;
    let octets = hint.octets();
    let prefix = [octets[0], octets[1], octets[2]];
    let next_host = AtomicU16::new(1);
    let matches = Mutex::new(Vec::<Ipv4Addr>::new());

    thread::scope(|scope| {
        for _ in 0..DISCOVERY_WORKERS {
            scope.spawn(|| loop {
                let host = next_host.fetch_add(1, Ordering::Relaxed);
                if host > 254 {
                    break;
                }
                let address = subnet_candidate(prefix, host as u8);
                let socket = SocketAddr::new(IpAddr::V4(address), port);
                if TcpStream::connect_timeout(&socket, timeout).is_ok() {
                    matches.lock().expect("discovery result lock").push(address);
                }
            });
        }
    });

    let mut matches = matches
        .into_inner()
        .map_err(|_| "自动扫描结果锁已损坏".to_string())?;
    matches.sort_unstable_by_key(|address| u32::from_be_bytes(address.octets()));
    matches.dedup();
    Ok(matches
        .into_iter()
        .map(|address| address.to_string())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subnet_candidate_stays_in_saved_hosts_network() {
        assert_eq!(
            subnet_candidate([192, 168, 1], 154),
            Ipv4Addr::new(192, 168, 1, 154)
        );
    }

    #[test]
    fn ipv4_hint_is_accepted_without_dns() {
        assert_eq!(
            resolve_ipv4_hint("192.168.1.60", 51_325).unwrap(),
            Ipv4Addr::new(192, 168, 1, 60)
        );
    }

    #[test]
    fn empty_hint_is_rejected() {
        assert!(resolve_ipv4_hint(" ", 4430).is_err());
    }
}
