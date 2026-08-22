const endpoint = process.env.KING_WEBVIEW_DEBUG_URL ?? "http://127.0.0.1:9229";
const targets = await (await fetch(`${endpoint}/json/list`)).json();
const target = targets.find((item) => /localhost:1420\/$/.test(item.url));
if (!target) throw new Error("main WebView target not found");

const messages = await new Promise((resolve, reject) => {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const values = [];
  const timeout = setTimeout(() => {
    socket.close();
    resolve(values);
  }, 2500);
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ id: 1, method: "Runtime.enable" }));
    socket.send(JSON.stringify({ id: 2, method: "Page.enable" }));
    socket.send(JSON.stringify({ id: 3, method: "Page.reload", params: { ignoreCache: true } }));
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method === "Runtime.exceptionThrown") values.push(message.params.exceptionDetails);
    if (message.method === "Runtime.consoleAPICalled") values.push(message.params);
  });
  socket.addEventListener("error", (error) => {
    clearTimeout(timeout);
    reject(error);
  });
});

console.log(JSON.stringify(messages, null, 2));
