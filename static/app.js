const state = {
  currentUser: null,
  currentChatId: null,
  chatHistory: [],
  sources: [],
  imageDataUrl: null,
  firebaseReady: false,
  settings: {
    display_name: "",
    personalization: "",
    theme: "dark",
    default_model: "inf-1.0",
    web_search: "auto",
    response_style: "balanced",
  },
};

function qs(id) {
  return document.getElementById(id);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function api(path, options = {}) {
  const config = {
    credentials: "same-origin",
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  };

  if (config.body instanceof FormData) {
    delete config.headers["Content-Type"];
  }

  const res = await fetch(path, config);
  const contentType = res.headers.get("content-type") || "";

  let data;
  if (contentType.includes("application/json")) {
    data = await res.json();
  } else {
    const text = await res.text();
    data = { raw: text };
  }

  if (!res.ok) {
    throw new Error(data?.error || data?.message || `Request failed: ${res.status}`);
  }

  return data;
}

function openModal(id) {
  qs(id)?.classList.remove("hidden");
}

function closeModal(id) {
  qs(id)?.classList.add("hidden");
}

function setAuthTab(tab) {
  const loginTab = document.querySelector('[data-auth-tab="login"]');
  const signupTab = document.querySelector('[data-auth-tab="signup"]');
  const loginPane = qs("authPaneLogin");
  const signupPane = qs("authPaneSignup");

  if (tab === "signup") {
    loginTab?.classList.remove("active");
    signupTab?.classList.add("active");
    loginPane?.classList.add("hidden");
    signupPane?.classList.remove("hidden");
  } else {
    signupTab?.classList.remove("active");
    loginTab?.classList.add("active");
    signupPane?.classList.add("hidden");
    loginPane?.classList.remove("hidden");
  }
}

function autoResizeTextarea() {
  const input = qs("promptInput");
  if (!input) return;
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 240)}px`;
}

function renderUser() {
  const user = state.currentUser;
  qs("userName").textContent = user?.name || "Guest mode";
  qs("userEmail").textContent = user?.email || "Sign in only to save chats and sync settings";
  qs("userAvatar").textContent = user?.name?.[0]?.toUpperCase() || "∞";
}

function renderSettings() {
  const s = state.settings || {};
  document.body.setAttribute("data-theme", s.theme || "dark");

  qs("settingsDisplayName").value = s.display_name || "";
  qs("settingsPersonalization").value = s.personalization || "";
  qs("settingsTheme").value = s.theme || "dark";
  qs("settingsDefaultModel").value = s.default_model || "inf-1.0";
  qs("settingsWebSearch").value = s.web_search || "auto";
  qs("settingsResponseStyle").value = s.response_style || "balanced";

  qs("modelSelect").value = s.default_model || "inf-1.0";
  qs("webSearchSelect").value = s.web_search || "auto";
}

function renderHero() {
  qs("messages").innerHTML = `
    <div class="hero-card">
      <div class="hero-pill">INF-1.0</div>
      <h1>What do you want to work on?</h1>
      <p>
        Search the web with DuckDuckGo, route requests across models, attach images for vision-first analysis,
        and personalise the assistant from settings.
      </p>
      <div class="suggestions">
        <button class="suggestion">Find the latest AI product news and summarise the biggest updates</button>
        <button class="suggestion">Review this Python code for bugs and cleanup</button>
        <button class="suggestion">Create a product strategy for a student startup</button>
        <button class="suggestion">Explain this image and answer my question</button>
      </div>
    </div>
  `;

  document.querySelectorAll(".suggestion").forEach((btn) => {
    btn.addEventListener("click", () => {
      qs("promptInput").value = btn.textContent.trim();
      autoResizeTextarea();
      qs("promptInput").focus();
    });
  });
}

function renderMessages() {
  if (!state.chatHistory.length) {
    renderHero();
    return;
  }

  const html = state.chatHistory
    .map((msg) => {
      const label = msg.role === "user" ? "You" : (msg.label || "INF-1.0");
      return `
        <div class="message ${msg.role === "user" ? "user" : "assistant"}">
          <div class="message-meta">${escapeHtml(label)}</div>
          <div class="message-body">${escapeHtml(msg.content).replace(/\n/g, "<br>")}</div>
        </div>
      `;
    })
    .join("");

  qs("messages").innerHTML = html;
  qs("messages").scrollTop = qs("messages").scrollHeight;
}

function appendMessage(role, content, label = null) {
  const entry = { role, content, label };
  state.chatHistory.push(entry);

  const messagesEl = qs("messages");
  if (messagesEl.querySelector(".hero-card")) {
    messagesEl.innerHTML = "";
  }

  const wrapper = document.createElement("div");
  wrapper.className = `message ${role === "user" ? "user" : "assistant"}`;
  wrapper.innerHTML = `
    <div class="message-meta">${escapeHtml(label || (role === "user" ? "You" : "INF-1.0"))}</div>
    <div class="message-body">${escapeHtml(content).replace(/\n/g, "<br>")}</div>
  `;
  messagesEl.appendChild(wrapper);
  wrapper.scrollIntoView({ behavior: "smooth", block: "end" });
}

function renderSources(sources) {
  state.sources = sources || [];
  const panel = qs("sourcePanel");
  const list = qs("sourceList");

  if (!state.sources.length) {
    panel.classList.add("hidden");
    list.innerHTML = "";
    return;
  }

  panel.classList.remove("hidden");
  list.innerHTML = state.sources
    .map(
      (source) => `
        <a class="source-card" href="${escapeHtml(source.url || "#")}" target="_blank" rel="noopener noreferrer">
          <div class="source-title">${escapeHtml(source.title || "Untitled source")}</div>
          <div class="source-url">${escapeHtml(source.url || "")}</div>
          <div class="source-snippet">${escapeHtml(source.snippet || "")}</div>
        </a>
      `
    )
    .join("");
}

function renderChats(chats) {
  const container = qs("historyList");

  if (!chats.length) {
    container.innerHTML = `
      <div class="history-empty">
        ${state.currentUser ? "No saved chats yet" : "Sign in to save chat history"}
      </div>
    `;
    return;
  }

  container.innerHTML = chats
    .map(
      (chat) => `
        <div class="history-item ${chat.chat_id === state.currentChatId ? "active" : ""}" data-chat-id="${escapeHtml(chat.chat_id)}">
          <button class="history-open" data-open-chat="${escapeHtml(chat.chat_id)}">
            ${escapeHtml(chat.title || "Untitled chat")}
          </button>
          <button class="history-delete" data-delete-chat="${escapeHtml(chat.chat_id)}" title="Delete chat">✕</button>
        </div>
      `
    )
    .join("");

  container.querySelectorAll("[data-open-chat]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await loadChat(btn.dataset.openChat);
    });
  });

  container.querySelectorAll("[data-delete-chat]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await deleteChat(btn.dataset.deleteChat);
    });
  });
}

async function refreshSession() {
  const data = await api("/me", { method: "GET" }).catch(() => ({ logged_in: false }));

  if (data.logged_in) {
    state.currentUser = data.user;
    state.settings = { ...state.settings, ...(data.settings || {}) };
    renderUser();
    renderSettings();
    await loadChats();
  } else {
    state.currentUser = null;
    renderUser();
    renderSettings();
    renderChats([]);
  }
}

async function loadChats() {
  if (!state.currentUser) {
    renderChats([]);
    return;
  }
  const data = await api("/get_chats", { method: "GET" });
  renderChats(data.chats || []);
}

async function loadChat(chatId) {
  if (!state.currentUser) return;

  const data = await api(`/get_chat/${chatId}`, { method: "GET" });
  state.currentChatId = chatId;
  state.chatHistory = data.messages || [];
  renderMessages();
  renderSources([]);
}

async function createChat() {
  state.chatHistory = [];
  renderMessages();
  renderSources([]);

  if (!state.currentUser) {
    state.currentChatId = `guest-${crypto.randomUUID()}`;
    return;
  }

  const data = await api("/new_chat", { method: "POST" });
  state.currentChatId = data.chat_id;
  await loadChats();
}

async function deleteChat(chatId) {
  if (!state.currentUser) return;

  await api(`/delete_chat/${chatId}`, { method: "DELETE" });
  if (state.currentChatId === chatId) {
    state.currentChatId = null;
    state.chatHistory = [];
    renderMessages();
    renderSources([]);
  }
  await loadChats();
}

function clearImage() {
  state.imageDataUrl = null;
  qs("imageInput").value = "";
  qs("uploadPreview").classList.add("hidden");
  qs("uploadPreview").innerHTML = "";
}

function setImagePreview(dataUrl, fileName) {
  state.imageDataUrl = dataUrl;
  const preview = qs("uploadPreview");
  preview.classList.remove("hidden");
  preview.innerHTML = `
    <div class="upload-chip">
      <img src="${dataUrl}" alt="Upload preview" />
      <div class="upload-copy">
        <div class="upload-name">${escapeHtml(fileName || "image")}</div>
        <div class="upload-note">Vision will be used automatically</div>
      </div>
      <button type="button" class="ghost icon-only" id="removeImageBtn">✕</button>
    </div>
  `;
  qs("removeImageBtn").addEventListener("click", clearImage);
}

async function handleImageSelection(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => setImagePreview(reader.result, file.name);
  reader.readAsDataURL(file);
}

async function sendMessage() {
  const input = qs("promptInput");
  const message = input.value.trim();
  if (!message && !state.imageDataUrl) return;

  if (!state.currentChatId) {
    await createChat();
  }

  appendMessage("user", message || "[Image uploaded]");
  input.value = "";
  autoResizeTextarea();

  const typingEl = document.createElement("div");
  typingEl.className = "message assistant";
  typingEl.innerHTML = `<div class="message-meta">INF-1.0</div><div class="message-body">Thinking…</div>`;
  qs("messages").appendChild(typingEl);
  typingEl.scrollIntoView({ behavior: "smooth", block: "end" });

  try {
    const payload = {
      chat_id: state.currentUser ? state.currentChatId : null,
      message,
      model: qs("modelSelect").value,
      web_search: qs("webSearchSelect").value,
      image: state.imageDataUrl,
      history: state.chatHistory.map((m) => ({ role: m.role, content: m.content })),
    };

    const data = await api("/chat", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    typingEl.remove();
    appendMessage("assistant", data.response, data.used_mode ? `INF-1.0 · ${data.used_mode}` : "INF-1.0");

    if (state.currentUser) {
      state.currentChatId = data.chat_id || state.currentChatId;
      await loadChats();
    }

    renderSources(data.sources || []);
    clearImage();
  } catch (error) {
    typingEl.remove();
    appendMessage("assistant", `Error: ${error.message}`);
  }
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

  if (!state.currentUser) {
    state.settings = { ...state.settings, ...payload };
    renderSettings();
    closeModal("settingsModal");
    return;
  }

  const data = await api("/settings", { method: "POST", body: JSON.stringify(payload) });
  state.settings = data.settings;
  renderSettings();
  closeModal("settingsModal");
}

async function localLogin() {
  const email = qs("loginEmail").value.trim();
  const password = qs("loginPassword").value;

  if (!email || !password) return;

  await api("/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });

  closeModal("authModal");
  await refreshSession();
}

async function localSignup() {
  const name = qs("signupName").value.trim();
  const email = qs("signupEmail").value.trim();
  const password = qs("signupPassword").value;

  if (!name || !email || !password) return;

  await api("/signup", {
    method: "POST",
    body: JSON.stringify({ name, email, password }),
  });

  closeModal("authModal");
  await refreshSession();
}

async function guestLogin() {
  await api("/guest_login", { method: "POST" }).catch(() => null);
  closeModal("authModal");
  await refreshSession();
}

async function logout() {
  await api("/logout", { method: "POST" });
  state.currentUser = null;
  state.currentChatId = null;
  state.chatHistory = [];
  renderUser();
  renderChats([]);
  renderMessages();
  renderSources([]);
}

function initFirebase() {
  try {
    if (!window.firebase || !window.firebaseConfig) return;
    if (!firebase.apps.length) {
      firebase.initializeApp(window.firebaseConfig);
    }
    state.firebaseReady = true;
  } catch (error) {
    console.error("Firebase init failed", error);
  }
}

async function googleLogin() {
  if (!state.firebaseReady || !window.firebase?.auth) {
    alert("Google login is not configured yet.");
    return;
  }

  const provider = new firebase.auth.GoogleAuthProvider();
  const result = await firebase.auth().signInWithPopup(provider);
  const idToken = await result.user.getIdToken();

  await api("/firebase_login", {
    method: "POST",
    body: JSON.stringify({ id_token: idToken }),
  });

  closeModal("authModal");
  await refreshSession();
}

function bindEvents() {
  qs("composerForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    await sendMessage();
  });

  qs("promptInput")?.addEventListener("input", autoResizeTextarea);
  qs("promptInput")?.addEventListener("keydown", async (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      await sendMessage();
    }
  });

  qs("newChatBtn")?.addEventListener("click", async () => {
    await createChat();
  });

  qs("settingsBtn")?.addEventListener("click", () => openModal("settingsModal"));
  qs("loginBtn")?.addEventListener("click", () => openModal("authModal"));
  qs("logoutBtn")?.addEventListener("click", logout);
  qs("saveSettingsBtn")?.addEventListener("click", saveSettings);
  qs("localLoginBtn")?.addEventListener("click", localLogin);
  qs("localSignupBtn")?.addEventListener("click", localSignup);
  qs("guestLoginBtn")?.addEventListener("click", guestLogin);
  qs("googleLoginBtn")?.addEventListener("click", googleLogin);

  document.querySelectorAll("[data-auth-tab]").forEach((btn) => {
    btn.addEventListener("click", () => setAuthTab(btn.dataset.authTab));
  });

  document.querySelectorAll("[data-close]").forEach((btn) => {
    btn.addEventListener("click", () => closeModal(btn.dataset.close));
  });

  qs("toggleSidebarBtn")?.addEventListener("click", () => {
    qs("sidebar")?.classList.toggle("open");
  });

  qs("toggleSidebarBtn2")?.addEventListener("click", () => {
    qs("sidebar")?.classList.toggle("open");
  });

  qs("settingsTheme")?.addEventListener("change", (e) => {
    document.body.setAttribute("data-theme", e.target.value);
  });

  qs("imageInput")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    await handleImageSelection(file);
  });

  window.addEventListener("click", (e) => {
    if (e.target.classList?.contains("modal")) {
      e.target.classList.add("hidden");
    }
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
