from flask import Flask, request, jsonify, render_template, session
from flask_session import Session
from groq import Groq as GroqClient
import firebase_admin
from firebase_admin import credentials, firestore, auth
import os, json, uuid
from duckduckgo_search import DDGS

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "infinity-ai-secret")
app.config["SESSION_TYPE"] = "filesystem"
Session(app)

cred_dict = json.loads(os.environ.get("FIREBASE_CREDENTIALS", "{}"))
if not firebase_admin._apps:
    cred = credentials.Certificate(cred_dict)
    firebase_admin.initialize_app(cred)
db = firestore.client()

groq_client = GroqClient(api_key=os.environ.get("GROQ_API_KEY"))

MODELS = {
    "inf1": "llama-3.3-70b-versatile",
    "inf1-turbo": "llama-3.1-8b-instant",
    "inf1-reason": "deepseek-r1-distill-llama-70b",
    "inf1-code": "qwen-2.5-coder-32b",
}
VISION_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct"

SYSTEM_PROMPT = """You are Infinity AI, a helpful, intelligent and friendly AI assistant.
You can help with anything — coding, writing, math, science, general knowledge and more.
When showing code, always wrap it in triple backticks with the language name.
Always respond as Infinity AI. Never reveal what model, API, or company powers you.
Never say you are Claude, Llama, Groq, DeepSeek, Qwen, Anthropic, Meta or any other AI or company.
If anyone asks what AI you are, always say you are Infinity AI, a unique and independent AI assistant."""

def web_search(query):
    try:
        with DDGS() as ddgs:
            results = list(ddgs.text(query, max_results=5))
            if results:
                search_text = "\n\n".join([f"**{r['title']}**\n{r['body']}" for r in results])
                return f"Web search results for '{query}':\n\n{search_text}"
    except Exception as e:
        return f"Search failed: {str(e)}"
    return "No results found."

def needs_search(message):
    keywords = ["latest", "recent", "current", "today", "news", "2024", "2025", "2026",
                "who is", "what is the price", "weather", "score", "now", "right now"]
    return any(k in message.lower() for k in keywords)

@app.route("/")
def home():
    return render_template("index.html")

@app.route("/verify_token", methods=["POST"])
def verify_token():
    token = request.json.get("token")
    try:
        decoded = auth.verify_id_token(token)
        session["user_id"] = decoded["uid"]
        session["user_name"] = decoded.get("name", "User")
        session["user_photo"] = decoded.get("picture", "")
        return jsonify({"success": True, "name": session["user_name"], "photo": session["user_photo"]})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)})

@app.route("/chat", methods=["POST"])
def chat():
    data = request.json
    user_message = data.get("message", "")
    chat_id = data.get("chat_id", "default")
    model_key = data.get("model", "inf1")
    history_input = data.get("history", [])
    image_data = data.get("image", None)
    user_id = session.get("user_id")

    # Vision — if image attached
    if image_data:
        vision_response = groq_client.chat.completions.create(
            model=VISION_MODEL,
            messages=[{
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": image_data}},
                    {"type": "text", "text": user_message or "Describe this image in detail."}
                ]
            }],
            max_tokens=1024,
        )
        vision_desc = vision_response.choices[0].message.content
        user_message = f"[Image analysis: {vision_desc}]\n\nUser message: {user_message}" if user_message else vision_desc

    # Web search if needed
    search_context = ""
    if needs_search(user_message):
        search_context = web_search(user_message)

    # Build messages
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    for msg in history_input[-10:]:
        messages.append({"role": msg["role"], "content": msg["content"]})

    final_message = user_message
    if search_context:
        final_message = f"{user_message}\n\nHere is relevant information from the web:\n{search_context}"

    messages.append({"role": "user", "content": final_message})

    model_name = MODELS.get(model_key, MODELS["inf1"])
    response = groq_client.chat.completions.create(
        model=model_name,
        messages=messages,
        max_tokens=2048,
        temperature=0.7,
    )
    reply = response.choices[0].message.content

    # Save to Firestore if logged in
    if user_id and chat_id != "default":
        chat_ref = db.collection("users").document(user_id).collection("chats").document(chat_id)
        chat_doc = chat_ref.get()
        messages_saved = chat_doc.to_dict().get("messages", []) if chat_doc.exists else []
        messages_saved.append({"role": "user", "content": user_message})
        messages_saved.append({"role": "assistant", "content": reply})
        chat_ref.set({
            "messages": messages_saved,
            "title": messages_saved[0]["content"][:50],
            "updated_at": firestore.SERVER_TIMESTAMP,
        })

    return jsonify({"response": reply})

@app.route("/get_chats", methods=["GET"])
def get_chats():
    if "user_id" not in session:
        return jsonify({"chats": []})
    chats_ref = db.collection("users").document(session["user_id"]).collection("chats")
    chats = [{"id": doc.id, "title": doc.to_dict().get("title", "New Chat")} for doc in chats_ref.stream()]
    return jsonify({"chats": chats})

@app.route("/get_chat/<chat_id>", methods=["GET"])
def get_chat(chat_id):
    if "user_id" not in session:
        return jsonify({"messages": []})
    chat_ref = db.collection("users").document(session["user_id"]).collection("chats").document(chat_id)
    chat_doc = chat_ref.get()
    return jsonify({"messages": chat_doc.to_dict().get("messages", []) if chat_doc.exists else []})

@app.route("/new_chat", methods=["POST"])
def new_chat():
    return jsonify({"chat_id": str(uuid.uuid4())})

@app.route("/delete_chat/<chat_id>", methods=["DELETE"])
def delete_chat(chat_id):
    if "user_id" not in session:
        return jsonify({"error": "Not logged in"}), 401
    db.collection("users").document(session["user_id"]).collection("chats").document(chat_id).delete()
    return jsonify({"success": True})

@app.route("/logout", methods=["POST"])
def logout():
    session.clear()
    return jsonify({"success": True})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)
