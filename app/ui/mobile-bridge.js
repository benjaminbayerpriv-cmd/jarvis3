// WebView und LAN-Browser verwenden dieselbe Oberfläche. Zugangsdaten bleiben in Android.
const android = window.JarvisAndroid;
export const isAndroid = Boolean(android);
export const isMobileRemote = isAndroid || (!window.__TAURI__ && location.protocol === "https:");
export const smallScreen = () => matchMedia("(max-width: 700px), (pointer: coarse) and (max-height: 540px)").matches;
export const httpOrigin = isMobileRemote ? location.origin
  : location.protocol === "http:" && location.port ? location.origin : "http://127.0.0.1:7777";

let socket;
let requestId = 0;
const requests = new Map();
if (android) android.onmessage = ({ data }) => {
  const event = JSON.parse(data);
  switch (event.type) {
    case "open":
      if (socket) { socket.readyState = 1; socket.onopen?.(); }
      break;
    case "socket":
      socket?.onmessage?.({ data: event.data });
      break;
    case "close":
      if (socket) { socket.readyState = 3; socket.onclose?.(); }
      break;
    case "result":
      requests.get(event.id)?.(event.value);
      requests.delete(event.id);
      break;
    case "back":
      document.dispatchEvent(new Event("jarvis-back"));
      break;
  }
};

export const nativeSend = (type, fields = {}) => android?.postMessage(JSON.stringify({ type, ...fields }));
export function nativeRequest(type, fields = {}) {
  return new Promise(resolve => {
    const id = ++requestId;
    requests.set(id, resolve);
    nativeSend(type, { ...fields, id });
  });
}
export function uiSocket() {
  if (!android) return new WebSocket(httpOrigin.replace(/^http/, "ws") + "/ui");
  socket = { readyState: 0, send: data => nativeSend("send", { data }) };
  nativeSend("connect");
  return socket;
}
