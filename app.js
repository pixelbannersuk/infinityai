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

function toast(message) {
  let el = document.querySelector(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove("show"), 2200);
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

  const res = await fetch(path, config);
  const contentType = res.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await res.json() : await res.text();

  if (!res.ok) {
    throw new Error(data?.error || "Request failed");
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
  input.style.height = `${Math.min(input.scrollHeight, 260)}px`;
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
  qs("settingsWebSearch").value = s.web_search || "auto";
  qs("settingsResponseStyle").value = s.response_style || "balanced";
  qs("webSearchSelect").value = s.web_search || "auto";
}

function renderHero() {
  qs("messages").innerHTML = `
    <div class="hero-card premium-hero">
      <div class="hero-pill">INF-1.0</div>
      <h1>One premium AI that does it all.</h1>
      <p>Ask anything. INF-1.0 silently combines reasoning, coding, vision, and live web context into one polished answer.</p>
      <div class="suggestions">
        <button class="suggestion">Summarise the latest AI product news</button>
        <button class="suggestion">Review this Python code for bugs and improvements</button>
        <button class="suggestion">Create a product strategy for a student startup</button>
        <button class="suggestion">Analyse this image and explain what matters</button>
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

function renderRichText(content) {
  const escaped = escapeHtml(content);
  const codeBlocks = [];
  let html = escaped.replace(/```(\w+)?
([\s\S]*?)```/g, (_, lang, code) => {
    const index = codeBlocks.push({ lang: lang || "", code }) - 1;
    return `__CODE_BLOCK_${index}__`;
  });

  html = html
    .replace(/^### (.*)$/gm, "<h3>$1</h3>")
    .replace(/^## (.*)$/gm, "<h2>$1</h2>")
    .replace(/^# (.*)$/gm, "<h1>$1</h1>")
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/

/g, "</p><p>")
    .replace(/
/g, "<br>");

  html = `<p>${html}</p>`;
  html = html.replace(/<p><\/p>/g, "");

  codeBlocks.forEach((block, index) => {
    const replacement = `
      <div class="code-block" data-copy="${encodeURIComponent(block.code)}">
        <div class="code-block-top">
          <span>${escapeHtml(block.lang || "code")}</span>
          <button class="copy-code-btn" type="button">Copy</button>
        </div>
        <pre><code>${block.code}</code></pre>
      </div>
    `;
    html = html.replace(`__CODE_BLOCK_${index}__`, replacement);
  });

  return html;
}

function attachCopyHandlers(scope = document) {
  scope.querySelectorAll(".copy-code-btn").forEach((btn) => {
    if (btn.dataset.bound === "1") return;
    btn.dataset.bound = "1";
    btn.addEventListener("click", async () => {
      const code = decodeURIComponent(btn.closest(".code-block")?.dataset.copy || "");
      await navigator.clipboard.writeText(code);
      const old = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(() => (btn.textContent = old), 1400);
    });
  });

  scope.querySelectorAll("[data-copy-message]").forEach((btn) => {
    if (btn.dataset.bound === "1") return;
    btn.dataset.bound = "1";
    btn.addEventListener("click", async () => {
      const text = decodeURIComponent(btn.dataset.copyMessage || "");
      await navigator.clipboard.writeText(text);
      toast("Copied response");
    });
  });
}

function renderMessages() {
  if (!state.chatHistory.length) {
    renderHero();
    return;
  }

  qs("messages").innerHTML = state.chatHistory
    .map((msg) => {
      const label = msg.role === "user" ? "You" : (msg.label || "INF-1.0");
      const actions = msg.role === "assistant"
        ? `<div class="message-actions"><button class="mini-action" type="button" data-copy-message="${encodeURIComponent(msg.content)}">Copy</button></div>`
        : "";
      return `
        <div class="message ${msg.role === "user" ? "user" : "assistant"}">
          <div class="message-meta-row">
            <div class="message-meta">${escapeHtml(label)}</div>
            ${actions}
          </div>
          <div class="message-body rich-text">${msg.role === "assistant" ? renderRichText(msg.content) : escapeHtml(msg.content).replace(/
/g, "<br>")}</div>
        </div>
      `;
    })
    .join("");

  attachCopyHandlers(qs("messages"));
  qs("messages").scrollTop = qs("messages").scrollHeight;
}

function appendMessage(role, content, label = null) {
  state.chatHistory.push({ role, content, label });
  renderMessages();
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
        <a class="source-card fade-in" href="${escapeHtml(source.url || "#")}" target="_blank" rel="noopener noreferrer">
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
        ${state.currentUser ? "No saved chats yet" : "Use guest mode freely. Sign in only to save chats."}
      </div>
    `;
    return;
  }

  container.innerHTML = chats
    .map(
      (chat) => `
        <div class="history-item ${chat.chat_id === state.currentChatId ? "active" : ""}">
          <button class="history-open" data-open-chat="${escapeHtml(chat.chat_id)}">${escapeHtml(chat.title || "Untitled chat")}</button>
          <button class="history-delete" data-delete-chat="${escapeHtml(chat.chat_id)}">✕</button>
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
  state.currentChatId = `guest-${crypto.randomUUID()}`;
  state.chatHistory = [];
  renderMessages();
  renderSources([]);

  if (!state.currentUser) return;

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
    <div class="upload-chip fade-in">
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
  typingEl.className = "message assistant fade-in";
  typingEl.innerHTML = `<div class="message-meta-row"><div class="message-meta">INF-1.0</div></div><div class="message-body typing">Thinking<span></span><span></span><span></span></div>`;
  qs("messages").appendChild(typingEl);
  typingEl.scrollIntoView({ behavior: "smooth", block: "end" });

  try {
    const payload = {
      chat_id: state.currentUser ? state.currentChatId : null,
      message,
      web_search: qs("webSearchSelect").value,
      image: state.imageDataUrl,
      history: state.chatHistory
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role, content: m.content })),
    };

    const data = await api("/chat", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    typingEl.remove();
    appendMessage("assistant", data.response, "INF-1.0");

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
    web_search: qs("settingsWebSearch").value,
    response_style: qs("settingsResponseStyle").value,
  };

  if (!state.currentUser) {
    state.settings = { ...state.settings, ...payload, default_model: "inf-1.0" };
    renderSettings();
    closeModal("settingsModal");
    toast("Settings saved locally");
    return;
  }

  const data = await api("/settings", { method: "POST", body: JSON.stringify(payload) });
  state.settings = { ...data.settings, default_model: "inf-1.0" };
  renderSettings();
  closeModal("settingsModal");
  toast("Settings saved");
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
  toast("Signed in");
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
  toast("Account created");
}

async function guestLogin() {
  closeModal("authModal");
  state.currentUser = null;
  renderUser();
  renderChats([]);
  toast("Continuing in guest mode");
}

async function logout() {
  await api("/logout", { method: "POST" }).catch(() => null);
  state.currentUser = null;
  state.currentChatId = null;
  state.chatHistory = [];
  renderUser();
  renderChats([]);
  renderMessages();
  renderSources([]);
  toast("Signed out");
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

  await api("/verify_token", {
    method: "POST",
    body: JSON.stringify({ token: idToken }),
  });

  closeModal("authModal");
  await refreshSession();
  toast("Signed in with Google");
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

  qs("toggleSidebarBtn")?.addEventListener("click", () => qs("sidebar")?.classList.toggle("open"));
  qs("toggleSidebarBtn2")?.addEventListener("click", () => qs("sidebar")?.classList.toggle("open"));

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
