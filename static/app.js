const FIREBASE_CONFIG = {
  apiKey: "",
  authDomain: "",
  projectId: "",
  appId: "",
};

const state = {
  currentUser: null,
  currentChatId: null,
  chatHistory: [],
  settings: {
    display_name: "",
    personalization: "",
    theme: "dark",
    default_model: "inf-1.0",
    web_search: "auto",
    response_style: "balanced",
  },
  imageDataUrl: null,
  firebaseReady: false,
};

const qs = (id) => document.getElementById(id);

function escapeHtml(value = "") {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function markdownLite(text = "") {
  const blocks = escapeHtml(text)
    .replace(/```([\s\S]*?)```/g, (_, code) => `<pre><code>${code.trim()}</code></pre>`)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.*?)\*/g, "<em>$1</em>")
    .replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return blocks.replace(/\n/g, "<br>");
}

function setTheme(theme) {
  document.body.dataset.theme = theme || "dark";
}

function openModal(id) {
  qs(id).classList.remove("hidden");
}

function closeModal(id) {
  qs(id).classList.add("hidden");
}

function setAuthTab(active) {
  document.querySelectorAll("[data-auth-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.authTab === active);
  });
  qs("authPaneLogin").classList.toggle("hidden", active !== "login");
  qs("authPaneSignup").classList.toggle("hidden", active !== "signup");
}

function renderUser() {
  const user = state.currentUser;
  qs("userName").textContent = user?.name || "Not signed in";
  qs("userEmail").textContent = user?.email || (user ? `${user.auth_provider || "guest"} session` : "Use guest, local login, or Firebase login");
  qs("userAvatar").textContent = user?.name?.[0]?.toUpperCase() || "∞";
}

function renderSettings() {
  qs("settingsDisplayName").value = state.settings.display_name || "";
  qs("settingsPersonalization").value = state.settings.personalization || "";
  qs("settingsTheme").value = state.settings.theme || "dark";
  qs("settingsDefaultModel").value = state.settings.default_model || "inf-1.0";
  qs("settingsWebSearch").value = state.settings.web_search || "auto";
  qs("settingsResponseStyle").value = state.settings.response_style || "balanced";
  qs("modelSelect").value = state.settings.default_model || "inf-1.0";
  qs("webSearchSelect").value = state.settings.web_search || "auto";
  setTheme(state.settings.theme || "dark");
}

function appendMessage(role, content, meta = "") {
  const wrapper = document.createElement("div");
  wrapper.className = `message ${role}`;
  wrapper.innerHTML = `
    <div class="message-meta">${meta || (role === "user" ? "You" : "INF-1.0")}</div>
    <div class="message-body">${markdownLite(content)}</div>
  `;
  qs("messages").appendChild(wrapper);
  wrapper.scrollIntoView({ behavior: "smooth", block: "end" });
}

function renderMessages() {
  const root = qs("messages");
  root.innerHTML = "";
  if (!state.chatHistory.length) {
    root.innerHTML = `
      <div class="hero-card">
        <div class="hero-pill">INF-1.0</div>
        <h1>What do you want to work on?</h1>
        <p>Try a question, a coding task, web search, or image analysis.</p>
      </div>
    `;
    return;
  }
  state.chatHistory.forEach((msg) => {
    appendMessage(msg.role === "assistant" ? "assistant" : "user", msg.content);
  });
}

function renderChats(chats) {
  const list = qs("historyList");
  list.innerHTML = "";
  chats.forEach((chat) => {
    const item = document.createElement("div");
    item.className = "history-item";
    item.innerHTML = `
      <div class="history-title"></div>
      <button class="ghost history-delete" title="Delete chat">✕</button>
    `;
    item.querySelector(".history-title").textContent = chat.title || "New chat";
    item.querySelector(".history-title").onclick = () => loadChat(chat.id);
    item.querySelector(".history-delete").onclick = async (event) => {
      event.stopPropagation();
      await deleteChat(chat.id);
    };
    list.appendChild(item);
  });
}

function renderSources(sources = []) {
  const panel = qs("sourcePanel");
  const list = qs("sourceList");
  list.innerHTML = "";
  if (!sources.length) {
    panel.classList.add("hidden");
    return;
  }
  sources.forEach((source, index) => {
    const el = document.createElement("div");
    el.className = "source-item";
    el.innerHTML = `
      <div class="source-item-title">${index + 1}. ${escapeHtml(source.title || "Untitled")}</div>
      <div class="source-item-snippet">${escapeHtml(source.snippet || "")}</div>
      <div class="source-item-link"><a href="${escapeHtml(source.url || "#")}" target="_blank" rel="noreferrer">${escapeHtml(source.url || "")}</a></div>
    `;
    list.appendChild(el);
  });
  panel.classList.remove("hidden");
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Request failed.");
  }
  return data;
}

async function refreshSession() {
  const data = await api("/me", { method: "GET" }).catch(() => ({ logged_in: false }));
  if (data.logged_in) {
    state.currentUser = data.user;
    state.settings = { ...state.settings, ...data.settings };
    renderUser();
    renderSettings();
    await loadChats();
  } else {
    state.currentUser = null;
    renderUser();
    openModal("authModal");
  }
}

async function loadChats() {
  const data = await api("/get_chats", { method: "GET" });
  renderChats(data.chats || []);
}

async function loadChat(chatId) {
  const data = await api(`/get_chat/${chatId}`, { method: "GET" });
  state.currentChatId = chatId;
  state.chatHistory = data.messages || [];
  renderMessages();
  renderSources([]);
}

async function createChat() {
  const data = await api("/new_chat", { method: "POST" });
  state.currentChatId = data.chat_id;
  state.chatHistory = [];
  renderMessages();
  renderSources([]);
  await loadChats();
}

async function deleteChat(chatId) {
  await api(`/delete_chat/${chatId}`, { method: "DELETE" });
  if (state.currentChatId === chatId) {
    state.currentChatId = null;
    state.chatHistory = [];
    renderMessages();
    renderSources([]);
  }
  await loadChats();
}

async function sendMessage() {
  const input = qs("promptInput");
  const message = input.value.trim();
  if (!message && !state.imageDataUrl) return;
  if (!state.currentUser) {
    openModal("authModal");
    return;
  }
  if (!state.currentChatId) {
    await createChat();
  }

  appendMessage("user", message || "[Image uploaded]");
  state.chatHistory.push({ role: "user", content: message || "[Image uploaded]" });
  input.value = "";
  autoResizeTextarea();

  const typingEl = document.createElement("div");
  typingEl.className = "message assistant";
  typingEl.innerHTML = `<div class="message-meta">INF-1.0</div><div class="message-body">Thinking…</div>`;
  qs("messages").appendChild(typingEl);
  typingEl.scrollIntoView({ behavior: "smooth", block: "end" });

  try {
    const payload = {
      chat_id: state.currentChatId,
      message,
      model: qs("modelSelect").value,
      web_search: qs("webSearchSelect").value,
      image: state.imageDataUrl,
      history: state.chatHistory,
    };
    const data = await api("/chat", { method: "POST", body: JSON.stringify(payload) });
    typingEl.remove();
    appendMessage("assistant", data.response, data.used_mode ? `INF-1.0 · ${data.used_mode}` : "INF-1.0");
    state.chatHistory.push({ role: "assistant", content: data.response });
    state.currentChatId = data.chat_id || state.currentChatId;
    renderSources(data.sources || []);
    clearImage();
    await loadChats();
  } catch (error) {
    typingEl.remove();
    appendMessage("assistant", `Error: ${error.message}`);
  }
}

function autoResizeTextarea() {
  const el = qs("promptInput");
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
}

function clearImage() {
  state.imageDataUrl = null;
  qs("imageInput").value = "";
  qs("uploadPreview").classList.add("hidden");
  qs("uploadPreview").textContent = "";
}

async function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function handleImageChange(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  state.imageDataUrl = await fileToDataUrl(file);
  qs("uploadPreview").classList.remove("hidden");
  qs("uploadPreview").textContent = `Image attached: ${file.name}`;
}

async function saveSettings() {
  const payload = {
    display_name: qs("settingsDisplayName").value.trim(),
    personalization: qs("settingsPersonalization").value.trim(),
    theme: qs("settingsTheme").value,
    default_model: qs("settingsDefaultModel").value,
    web_search: qs("settingsWebSearch").value,
    response_style: qs("settingsResponseStyle").value,
  };
  const data = await api("/settings", { method: "POST", body: JSON.stringify(payload) });
  state.settings = data.settings;
  renderSettings();
  closeModal("settingsModal");
}

async function logout() {
  await api("/logout", { method: "POST" });
  state.currentUser = null;
  state.currentChatId = null;
  state.chatHistory = [];
  renderUser();
  renderMessages();
  renderSources([]);
  openModal("authModal");
}

async function guestLogin() {
  const data = await api("/guest_login", { method: "POST" });
  state.currentUser = data.user;
  state.settings = { ...state.settings, ...data.settings };
  renderUser();
  renderSettings();
  closeModal("authModal");
  await createChat();
  await loadChats();
}

async function localLogin() {
  const payload = {
    email: qs("loginEmail").value.trim(),
    password: qs("loginPassword").value,
  };
  const data = await api("/login", { method: "POST", body: JSON.stringify(payload) });
  state.currentUser = data.user;
  state.settings = { ...state.settings, ...data.settings };
  renderUser();
  renderSettings();
  closeModal("authModal");
  await loadChats();
}

async function localSignup() {
  const payload = {
    name: qs("signupName").value.trim(),
    email: qs("signupEmail").value.trim(),
    password: qs("signupPassword").value,
  };
  const data = await api("/signup", { method: "POST", body: JSON.stringify(payload) });
  state.currentUser = data.user;
  state.settings = { ...state.settings, ...data.settings };
  renderUser();
  renderSettings();
  closeModal("authModal");
  await createChat();
  await loadChats();
}

async function googleLogin() {
  if (!state.firebaseReady) {
    alert("Firebase web config is missing. Add it in static/app.js first.");
    return;
  }
  const provider = new firebase.auth.GoogleAuthProvider();
  const result = await firebase.auth().signInWithPopup(provider);
  const token = await result.user.getIdToken();
  const data = await api("/verify_token", { method: "POST", body: JSON.stringify({ token }) });
  state.currentUser = data.user;
  state.settings = { ...state.settings, ...data.settings };
  renderUser();
  renderSettings();
  closeModal("authModal");
  await loadChats();
}

function initFirebase() {
  const canInit = FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.authDomain && FIREBASE_CONFIG.projectId && FIREBASE_CONFIG.appId;
  if (!canInit || typeof firebase === "undefined") return;
  firebase.initializeApp(FIREBASE_CONFIG);
  state.firebaseReady = true;
}

function bindEvents() {
  qs("composerForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    await sendMessage();
  });
  qs("promptInput").addEventListener("input", autoResizeTextarea);
  qs("promptInput").addEventListener("keydown", async (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      await sendMessage();
    }
  });
  qs("newChatBtn").addEventListener("click", createChat);
  qs("settingsBtn").addEventListener("click", () => openModal("settingsModal"));
  qs("loginBtn").addEventListener("click", () => openModal("authModal"));
  qs("logoutBtn").addEventListener("click", logout);
  qs("saveSettingsBtn").addEventListener("click", saveSettings);
  qs("guestLoginBtn").addEventListener("click", guestLogin);
  qs("googleLoginBtn").addEventListener("click", googleLogin);
  qs("localLoginBtn").addEventListener("click", localLogin);
  qs("localSignupBtn").addEventListener("click", localSignup);
  qs("imageInput").addEventListener("change", handleImageChange);
  qs("toggleSidebarBtn")?.addEventListener("click", () => qs("sidebar").classList.toggle("open"));
  qs("toggleSidebarBtn2")?.addEventListener("click", () => qs("sidebar").classList.toggle("open"));
  document.querySelectorAll("[data-close]").forEach((button) => {
    button.addEventListener("click", () => closeModal(button.dataset.close));
  });
  document.querySelectorAll(".suggestion").forEach((button) => {
    button.addEventListener("click", () => {
      qs("promptInput").value = button.textContent;
      autoResizeTextarea();
      qs("promptInput").focus();
    });
  });
  document.querySelectorAll("[data-auth-tab]").forEach((button) => {
    button.addEventListener("click", () => setAuthTab(button.dataset.authTab));
  });
}

window.addEventListener("DOMContentLoaded", async () => {
  initFirebase();
  bindEvents();
  renderUser();
  renderSettings();
  renderMessages();
  setAuthTab("login");
  await refreshSession();
});
