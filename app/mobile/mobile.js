const welcome = document.querySelector("#welcome");
const pairing = document.querySelector("#pair");
const status = document.querySelector("#pairStatus");
const download = document.querySelector("#download");

fetch("/mobile/downloads").then(response => response.json()).then(({ android }) => {
  download.hidden = !android;
  document.querySelector("#downloadStatus").textContent = android ? "" : "Das APK wurde auf deinem Jarvis-Computer noch nicht bereitgestellt.";
}).catch(() => {
  document.querySelector("#downloadStatus").textContent = "Der Download ist gerade nicht verfügbar.";
});

function showPairing() {
  welcome.hidden = true;
  pairing.hidden = false;
  document.querySelector("#pin").focus();
}

document.querySelector("#continue").onclick = async () => {
  document.querySelector("#continue").disabled = true;
  try {
    if ((await fetch("/mobile/session")).ok) return location.assign("/app/");
    showPairing();
  } catch {
    document.querySelector("#downloadStatus").textContent = "Jarvis ist gerade nicht erreichbar.";
  } finally {
    document.querySelector("#continue").disabled = false;
  }
};
if (new URLSearchParams(location.search).has("pair")) showPairing();

document.querySelector("#pairForm").onsubmit = async event => {
  event.preventDefault();
  const submit = event.currentTarget.querySelector("button");
  submit.disabled = true;
  status.textContent = "";
  try {
    const response = await fetch("/pair/complete", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pin: document.querySelector("#pin").value, name: "Handy-Browser", browser: true }),
    });
    if (response.ok) return location.replace("/app/");
    status.textContent = (await response.json()).error;
  } catch {
    status.textContent = "Jarvis ist gerade nicht erreichbar.";
  } finally {
    submit.disabled = false;
  }
};
