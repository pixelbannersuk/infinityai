import json
import os
import re
import sqlite3
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from duckduckgo_search import DDGS
from flask import Flask, jsonify, render_template, request, session, send_from_directory
from flask_session import Session
from groq import Groq
from werkzeug.security import check_password_hash, generate_password_hash

try:
    import firebase_admin
    from firebase_admin import auth, credentials, firestore
except Exception:  # pragma: no cover
    firebase_admin = None
    auth = None
    credentials = None
    firestore = None


BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "local.db"
STATIC_DIR = BASE_DIR / "static"
TEMPLATES_DIR = BASE_DIR / "templates"

DEFAULT_SETTINGS = {
    "display_name": "",
    "personalization": "",
    "theme": "dark",
    "default_model": "inf-1.0",
    "web_search": "auto",
    "response_style": "balanced",
}

MODELS = {
    "chat": "llama-3.3-70b-versatile",
    "fast": "llama-3.1-8b-instant",
    "reason": "deepseek-r1-distill-llama-70b",
    "code": "qwen-2.5-coder-32b",
}
VISION_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct"
SYSTEM_PROMPT = (
    "You are INF-1.0, a polished AI assistant for writing, coding, reasoning, planning, "
    "research, and image understanding. Be accurate, practical, and clear. Use bullet points "
    "only when they materially help. When web context is supplied, treat it as evidence and "
    "avoid fabricating beyond it."
)
ROUTER_PROMPT = (
    "Classify the user's request into exactly one label: chat, fast, reason, code. "
    "Return only the label. Use code for programming and debugging, reason for deep analysis, "
    "math, product strategy, comparisons, or careful tradeoffs, fast for lightweight prompts, "
    "and chat for everything else."
)
SYNTHESIS_PROMPT = (
    "You are INF-1.0 synthesizing specialist model outputs into one final answer. "
    "Keep the strongest ideas, remove contradictions, and do not mention internal routing or models."
)
SEARCH_TRIGGER_RE = re.compile(
    r"\b(latest|recent|current|today|news|score|price|weather|202[4-9]|2026|now|right now|stock|who is the|update|search|find online|look up|duckduckgo)\b",
    re.IGNORECASE,
)

app = Flask(__name__, template_folder=str(TEMPLATES_DIR), static_folder=str(STATIC_DIR))
app.secret_key = os.environ.get("SECRET_KEY", "dev-secret-change-me")
app.config["SESSION_TYPE"] = "filesystem"
app.config["SESSION_PERMANENT"] = False
Session(app)

groq_api_key = os.environ.get("GROQ_API_KEY", "")
groq_client = Groq(api_key=groq_api_key) if groq_api_key else None
firebase_db = None

if firebase_admin and not firebase_admin._apps:
    raw_creds = os.environ.get("FIREBASE_CREDENTIALS")
    if raw_creds:
        try:
            cred = credentials.Certificate(json.loads(raw_creds))
            firebase_admin.initialize_app(cred)
            firebase_db = firestore.client()
        except Exception:
            firebase_db = None


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def ensure_column(conn: sqlite3.Connection, table: str, column: str, ddl: str) -> None:
    existing = {row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    if column not in existing:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {ddl}")


def init_db() -> None:
    conn = get_conn()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
            user_id TEXT PRIMARY KEY,
            email TEXT UNIQUE,
            name TEXT,
            photo TEXT,
            auth_provider TEXT DEFAULT 'guest',
            password_hash TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS settings (
            user_id TEXT PRIMARY KEY,
            display_name TEXT DEFAULT '',
            personalization TEXT DEFAULT '',
            theme TEXT DEFAULT 'dark',
            default_model TEXT DEFAULT 'inf-1.0',
            web_search TEXT DEFAULT 'auto',
            response_style TEXT DEFAULT 'balanced',
            updated_at TEXT NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(user_id)
        );

        CREATE TABLE IF NOT EXISTS chats (
            chat_id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            title TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(user_id)
        );

        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY(chat_id) REFERENCES chats(chat_id)
        );
        """
    )
    ensure_column(conn, "users", "auth_provider", "auth_provider TEXT DEFAULT 'guest'")
    ensure_column(conn, "users", "password_hash", "password_hash TEXT")
    ensure_column(conn, "settings", "response_style", "response_style TEXT DEFAULT 'balanced'")
    conn.commit()
    conn.close()


init_db()


def require_model_client() -> None:
    if not groq_client:
        raise RuntimeError("GROQ_API_KEY is missing.")


def get_session_user() -> Optional[Dict[str, Any]]:
    user_id = session.get("user_id")
    if not user_id:
        return None
    return {
        "user_id": user_id,
        "email": session.get("user_email", ""),
        "name": session.get("user_name", ""),
        "photo": session.get("user_photo", ""),
        "auth_provider": session.get("auth_provider", "guest"),
    }


def set_session_user(user_id: str, email: str = "", name: str = "", photo: str = "", auth_provider: str = "guest") -> None:
    session["user_id"] = user_id
    session["user_email"] = email
    session["user_name"] = name
    session["user_photo"] = photo
    session["auth_provider"] = auth_provider


def upsert_local_user(
    user_id: str,
    email: str = "",
    name: str = "",
    photo: str = "",
    auth_provider: str = "guest",
    password_hash: Optional[str] = None,
) -> None:
    conn = get_conn()
    timestamp = now_iso()
    conn.execute(
        """
        INSERT INTO users (user_id, email, name, photo, auth_provider, password_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
            email = excluded.email,
            name = excluded.name,
            photo = excluded.photo,
            auth_provider = excluded.auth_provider,
            password_hash = COALESCE(excluded.password_hash, users.password_hash),
            updated_at = excluded.updated_at
        """,
        (user_id, email or None, name, photo, auth_provider, password_hash, timestamp, timestamp),
    )
    conn.execute(
        """
        INSERT INTO settings (user_id, display_name, personalization, theme, default_model, web_search, response_style, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO NOTHING
        """,
        (
            user_id,
            DEFAULT_SETTINGS["display_name"],
            DEFAULT_SETTINGS["personalization"],
            DEFAULT_SETTINGS["theme"],
            DEFAULT_SETTINGS["default_model"],
            DEFAULT_SETTINGS["web_search"],
            DEFAULT_SETTINGS["response_style"],
            timestamp,
        ),
    )
    conn.commit()
    conn.close()


def get_user_by_email(email: str) -> Optional[sqlite3.Row]:
    conn = get_conn()
    row = conn.execute("SELECT * FROM users WHERE lower(email) = lower(?)", (email,)).fetchone()
    conn.close()
    return row


def get_user_settings(user_id: str) -> Dict[str, Any]:
    conn = get_conn()
    row = conn.execute("SELECT * FROM settings WHERE user_id = ?", (user_id,)).fetchone()
    conn.close()
    if not row:
        return DEFAULT_SETTINGS.copy()
    return {key: row[key] for key in DEFAULT_SETTINGS.keys()}


def update_user_settings(user_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    current = get_user_settings(user_id)
    merged = {**current, **{k: v for k, v in payload.items() if k in DEFAULT_SETTINGS}}
    conn = get_conn()
    conn.execute(
        """
        INSERT INTO settings (user_id, display_name, personalization, theme, default_model, web_search, response_style, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
            display_name = excluded.display_name,
            personalization = excluded.personalization,
            theme = excluded.theme,
            default_model = excluded.default_model,
            web_search = excluded.web_search,
            response_style = excluded.response_style,
            updated_at = excluded.updated_at
        """,
        (
            user_id,
            merged["display_name"],
            merged["personalization"],
            merged["theme"],
            merged["default_model"],
            merged["web_search"],
            merged["response_style"],
            now_iso(),
        ),
    )
    conn.commit()
    conn.close()
    return merged


def create_chat_for_user(user_id: str, title: str = "New chat") -> str:
    chat_id = str(uuid.uuid4())
    timestamp = now_iso()
    conn = get_conn()
    conn.execute(
        "INSERT INTO chats (chat_id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        (chat_id, user_id, title, timestamp, timestamp),
    )
    conn.commit()
    conn.close()
    return chat_id


def list_chats_for_user(user_id: str) -> List[Dict[str, Any]]:
    conn = get_conn()
    rows = conn.execute(
        "SELECT chat_id, title, updated_at FROM chats WHERE user_id = ? ORDER BY updated_at DESC",
        (user_id,),
    ).fetchall()
    conn.close()
    return [{"id": row["chat_id"], "title": row["title"], "updated_at": row["updated_at"]} for row in rows]


def get_chat_messages(user_id: str, chat_id: str) -> List[Dict[str, Any]]:
    conn = get_conn()
    owned = conn.execute(
        "SELECT 1 FROM chats WHERE user_id = ? AND chat_id = ?",
        (user_id, chat_id),
    ).fetchone()
    if not owned:
        conn.close()
        return []
    rows = conn.execute(
        "SELECT role, content, created_at FROM messages WHERE chat_id = ? ORDER BY id ASC",
        (chat_id,),
    ).fetchall()
    conn.close()
    return [{"role": row["role"], "content": row["content"], "created_at": row["created_at"]} for row in rows]


def save_messages(user_id: str, chat_id: str, user_message: str, assistant_message: str) -> None:
    conn = get_conn()
    exists = conn.execute(
        "SELECT title FROM chats WHERE user_id = ? AND chat_id = ?",
        (user_id, chat_id),
    ).fetchone()
    if not exists:
        conn.close()
        raise ValueError("Chat not found")
    timestamp = now_iso()
    conn.executemany(
        "INSERT INTO messages (chat_id, role, content, created_at) VALUES (?, ?, ?, ?)",
        [
            (chat_id, "user", user_message, timestamp),
            (chat_id, "assistant", assistant_message, timestamp),
        ],
    )
    title = exists["title"]
    if title == "New chat":
        title = (user_message.strip() or "New chat")[:60]
    conn.execute(
        "UPDATE chats SET title = ?, updated_at = ? WHERE chat_id = ?",
        (title, timestamp, chat_id),
    )
    conn.commit()
    conn.close()


def delete_chat_for_user(user_id: str, chat_id: str) -> None:
    conn = get_conn()
    conn.execute(
        "DELETE FROM messages WHERE chat_id IN (SELECT chat_id FROM chats WHERE user_id = ? AND chat_id = ?)",
        (user_id, chat_id),
    )
    conn.execute("DELETE FROM chats WHERE user_id = ? AND chat_id = ?", (user_id, chat_id))
    conn.commit()
    conn.close()


def needs_web_search(text: str, mode: str) -> bool:
    if mode == "on":
        return True
    if mode == "off":
        return False
    return bool(SEARCH_TRIGGER_RE.search(text or ""))


def duckduckgo_search(query: str) -> Tuple[str, List[Dict[str, str]]]:
    try:
        with DDGS() as ddgs:
            results = list(ddgs.text(query, region="wt-wt", safesearch="moderate", max_results=6))
        cleaned = []
        for item in results:
            cleaned.append(
                {
                    "title": item.get("title", "Untitled"),
                    "snippet": item.get("body", ""),
                    "url": item.get("href", ""),
                }
            )
        if not cleaned:
            return "No useful DuckDuckGo results found.", []
        blocks = []
        for idx, item in enumerate(cleaned, start=1):
            blocks.append(f"[{idx}] {item['title']}\n{item['snippet']}\nSource: {item['url']}")
        return "\n\n".join(blocks), cleaned
    except Exception as exc:
        return f"DuckDuckGo search failed: {exc}", []


def normalize_history(history: List[Dict[str, Any]]) -> List[Dict[str, str]]:
    output = []
    for msg in history[-14:]:
        role = msg.get("role", "user")
        content = (msg.get("content") or "").strip()
        if role in {"user", "assistant", "system"} and content:
            output.append({"role": role, "content": content})
    return output


def build_system_prompt(settings: Dict[str, Any]) -> str:
    personalization = (settings.get("personalization") or "").strip()
    display_name = (settings.get("display_name") or "").strip()
    response_style = settings.get("response_style", "balanced")
    extra = [f"Response style preference: {response_style}."]
    if display_name:
        extra.append(f"Address the user as {display_name} when natural.")
    if personalization:
        extra.append(f"Personalization instructions from the user: {personalization}")
    return SYSTEM_PROMPT + "\n\n" + "\n".join(extra)


def choose_model(user_text: str) -> str:
    require_model_client()
    result = groq_client.chat.completions.create(
        model=MODELS["fast"],
        messages=[
            {"role": "system", "content": ROUTER_PROMPT},
            {"role": "user", "content": user_text[:2500]},
        ],
        temperature=0,
        max_tokens=8,
    )
    label = (result.choices[0].message.content or "chat").strip().lower()
    return label if label in MODELS else "chat"


def call_model(model_name: str, messages: List[Dict[str, str]], max_tokens: int = 1400) -> str:
    require_model_client()
    response = groq_client.chat.completions.create(
        model=model_name,
        messages=messages,
        temperature=0.45,
        max_tokens=max_tokens,
    )
    return response.choices[0].message.content or ""


def ensemble_reply(messages: List[Dict[str, str]]) -> str:
    specialist_map = {
        "reason": MODELS["reason"],
        "code": MODELS["code"],
        "chat": MODELS["chat"],
        "fast": MODELS["fast"],
    }
    outputs: Dict[str, str] = {}
    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = {
            executor.submit(call_model, model_name, messages, 850): label
            for label, model_name in specialist_map.items()
        }
        for future in as_completed(futures):
            label = futures[future]
            try:
                outputs[label] = future.result()
            except Exception as exc:
                outputs[label] = f"{label} specialist failed: {exc}"

    synthesis_messages = [
        {"role": "system", "content": SYNTHESIS_PROMPT},
        {
            "role": "user",
            "content": (
                "Combine these specialist outputs into one answer:\n\n"
                + "\n\n".join([f"[{label.upper()}]\n{text}" for label, text in outputs.items()])
            ),
        },
    ]
    return call_model(MODELS["chat"], synthesis_messages, 1200)


def analyze_image(image_data_url: str, user_text: str) -> str:
    require_model_client()
    response = groq_client.chat.completions.create(
        model=VISION_MODEL,
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": image_data_url}},
                    {
                        "type": "text",
                        "text": user_text or "Describe the image accurately and extract any relevant details for the user's goal.",
                    },
                ],
            }
        ],
        max_tokens=1200,
    )
    return response.choices[0].message.content or ""


@app.get("/")
def home():
    return render_template("index.html")


@app.get("/health")
def health():
    return jsonify({"ok": True, "has_groq": bool(groq_client), "has_firebase": bool(firebase_db)})


@app.post("/signup")
def signup():
    payload = request.json or {}
    email = (payload.get("email") or "").strip().lower()
    password = payload.get("password") or ""
    name = (payload.get("name") or "").strip() or (email.split("@")[0] if email else "User")
    if not email or not password:
        return jsonify({"error": "Email and password are required."}), 400
    if len(password) < 8:
        return jsonify({"error": "Password must be at least 8 characters."}), 400
    if get_user_by_email(email):
        return jsonify({"error": "An account with that email already exists."}), 409
    user_id = f"local_{uuid.uuid4().hex[:16]}"
    upsert_local_user(
        user_id,
        email=email,
        name=name,
        auth_provider="local",
        password_hash=generate_password_hash(password),
    )
    set_session_user(user_id, email=email, name=name, auth_provider="local")
    return jsonify({
        "success": True,
        "user": get_session_user(),
        "settings": get_user_settings(user_id),
    })


@app.post("/login")
def login():
    payload = request.json or {}
    email = (payload.get("email") or "").strip().lower()
    password = payload.get("password") or ""
    row = get_user_by_email(email)
    if not row or not row["password_hash"] or not check_password_hash(row["password_hash"], password):
        return jsonify({"error": "Invalid email or password."}), 401
    set_session_user(
        row["user_id"],
        email=row["email"] or "",
        name=row["name"] or "User",
        photo=row["photo"] or "",
        auth_provider=row["auth_provider"] or "local",
    )
    return jsonify({
        "success": True,
        "user": get_session_user(),
        "settings": get_user_settings(row["user_id"]),
    })


@app.post("/verify_token")
def verify_token():
    if not auth:
        return jsonify({"success": False, "error": "Firebase Admin is not configured on the server."}), 500

    token = (request.json or {}).get("token", "")
    if not token:
        return jsonify({"success": False, "error": "Missing token."}), 400

    try:
        decoded = auth.verify_id_token(token)
        uid = decoded["uid"]
        email = decoded.get("email", "")
        name = decoded.get("name", email.split("@")[0] if email else "User")
        photo = decoded.get("picture", "")
        set_session_user(uid, email=email, name=name, photo=photo, auth_provider="firebase")
        upsert_local_user(uid, email=email, name=name, photo=photo, auth_provider="firebase")
        settings = get_user_settings(uid)
        return jsonify(
            {
                "success": True,
                "user": {"user_id": uid, "email": email, "name": name, "photo": photo, "auth_provider": "firebase"},
                "settings": settings,
            }
        )
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 401


@app.post("/guest_login")
def guest_login():
    guest_id = f"guest_{uuid.uuid4().hex[:12]}"
    set_session_user(guest_id, name="Guest", auth_provider="guest")
    upsert_local_user(guest_id, name="Guest", auth_provider="guest")
    settings = get_user_settings(guest_id)
    return jsonify(
        {
            "success": True,
            "user": {"user_id": guest_id, "email": "", "name": "Guest", "photo": "", "auth_provider": "guest"},
            "settings": settings,
        }
    )


@app.post("/logout")
def logout():
    session.clear()
    return jsonify({"success": True})


@app.get("/me")
def me():
    user = get_session_user()
    if not user:
        return jsonify({"logged_in": False})
    return jsonify({"logged_in": True, "user": user, "settings": get_user_settings(user["user_id"])})


@app.get("/settings")
def settings_get():
    user = get_session_user()
    if not user:
        return jsonify(DEFAULT_SETTINGS)
    return jsonify(get_user_settings(user["user_id"]))


@app.post("/settings")
def settings_post():
    user = get_session_user()
    if not user:
        return jsonify({"error": "Not logged in."}), 401
    payload = request.json or {}
    saved = update_user_settings(user["user_id"], payload)
    return jsonify({"success": True, "settings": saved})


@app.post("/new_chat")
def new_chat():
    user = get_session_user()
    if not user:
        return jsonify({"error": "Not logged in."}), 401
    chat_id = create_chat_for_user(user["user_id"])
    return jsonify({"chat_id": chat_id})


@app.get("/get_chats")
def get_chats():
    user = get_session_user()
    if not user:
        return jsonify({"chats": []})
    return jsonify({"chats": list_chats_for_user(user["user_id"])})


@app.get("/get_chat/<chat_id>")
def get_chat(chat_id: str):
    user = get_session_user()
    if not user:
        return jsonify({"messages": []})
    return jsonify({"messages": get_chat_messages(user["user_id"], chat_id)})


@app.delete("/delete_chat/<chat_id>")
def delete_chat(chat_id: str):
    user = get_session_user()
    if not user:
        return jsonify({"error": "Not logged in."}), 401
    delete_chat_for_user(user["user_id"], chat_id)
    return jsonify({"success": True})


@app.post("/chat")
def chat():
    user = get_session_user()
    if not user:
        return jsonify({"error": "Please log in first."}), 401

    payload = request.json or {}
    chat_id = payload.get("chat_id")
    raw_user_message = (payload.get("message") or "").strip()
    image_data = payload.get("image")
    history = normalize_history(payload.get("history") or [])

    if not raw_user_message and not image_data:
        return jsonify({"error": "Message or image is required."}), 400

    if not chat_id:
        chat_id = create_chat_for_user(user["user_id"])

    settings = get_user_settings(user["user_id"])
    selected_model = payload.get("model") or settings.get("default_model", "inf-1.0")
    web_mode = payload.get("web_search") or settings.get("web_search", "auto")

    try:
        system_prompt = build_system_prompt(settings)
        messages: List[Dict[str, str]] = [{"role": "system", "content": system_prompt}] + history
        augmented_user_message = raw_user_message
        vision_summary = ""
        search_context = ""
        sources: List[Dict[str, str]] = []

        if image_data:
            vision_summary = analyze_image(image_data, raw_user_message)
            augmented_user_message = (
                f"Vision analysis:\n{vision_summary}\n\n"
                f"User request:\n{raw_user_message or 'Respond helpfully based on the image.'}"
            )

        if needs_web_search(augmented_user_message, web_mode):
            search_context, sources = duckduckgo_search(augmented_user_message)
            augmented_user_message = (
                f"{augmented_user_message}\n\nDuckDuckGo search context:\n{search_context}\n\n"
                "Ground claims in the supplied search context when relevant and say when evidence is thin."
            )

        messages.append({"role": "user", "content": augmented_user_message})

        if image_data:
            used_mode = "vision"
            if selected_model == "inf-1.0-all":
                reply = ensemble_reply(messages)
                used_mode = "vision+inf-1.0-all"
            elif selected_model == "inf-1.0":
                reply = call_model(MODELS["chat"], messages)
                used_mode = "vision+inf-1.0"
            else:
                model_name = MODELS.get(selected_model, MODELS["chat"])
                reply = call_model(model_name, messages)
                used_mode = f"vision+{selected_model}"
        else:
            if selected_model == "inf-1.0":
                routed = choose_model(augmented_user_message)
                reply = call_model(MODELS[routed], messages)
                used_mode = f"inf-1.0/{routed}"
            elif selected_model == "inf-1.0-all":
                reply = ensemble_reply(messages)
                used_mode = "inf-1.0-all"
            else:
                model_name = MODELS.get(selected_model, MODELS["chat"])
                reply = call_model(model_name, messages)
                used_mode = selected_model

        saved_user_content = raw_user_message or "[image]"
        save_messages(user["user_id"], chat_id, saved_user_content, reply)
        return jsonify({
            "response": reply,
            "chat_id": chat_id,
            "used_mode": used_mode,
            "sources": sources,
            "vision_summary": vision_summary,
        })
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.get("/favicon.ico")
def favicon():
    return send_from_directory(STATIC_DIR, "favicon.ico", mimetype="image/x-icon")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8080)), debug=True)
