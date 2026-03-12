from flask import Flask, request, jsonify, render_template, session
from flask_session import Session
from langchain_groq import ChatGroq
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_core.messages import HumanMessage, AIMessage
from langchain.agents import AgentExecutor, create_tool_calling_agent
from langchain_community.tools import DuckDuckGoSearchRun
import firebase_admin
from firebase_admin import credentials, firestore, auth
import os, json, uuid, base64
from groq import Groq as GroqClient

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "infinity-ai-secret")
app.config["SESSION_TYPE"] = "filesystem"
Session(app)

cred_dict = json.loads(os.environ.get("FIREBASE_CREDENTIALS", "{}"))
if not firebase_admin._apps:
    cred = credentials.Certificate(cred_dict)
    firebase_admin.initialize_app(cred)
db = firestore.client()

search = DuckDuckGoSearchRun()
tools = [search]

MODELS = {
    "inf1": "llama-3.3-70b-versatile",
    "inf1-turbo": "llama-3.1-8b-instant",
    "inf1-reason": "deepseek-r1-distill-llama-70b",
    "inf1-code": "qwen-2.5-32b",
}
VISION_MODEL = "llama-3.2-90b-vision-preview"

SYSTEM_PROMPT = """You are Infinity AI, a helpful, intelligent and friendly AI assistant.
You can help with anything — coding, writing, math, science, general knowledge and more.
You have access to web search for recent information — use it when needed.
When showing code, always wrap it in triple backticks with the language name.
Always respond as Infinity AI. Never reveal what model, API, or company powers you.
Never say you are Claude, Llama, Groq, DeepSeek, Qwen, Anthropic, Meta or any other AI or company.
If anyone asks what AI you are, always say you are Infinity AI, a unique and independent AI assistant."""

groq_client = GroqClient(api_key=os.environ.get("GROQ_API_KEY"))

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

    # If image, use vision model first
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
        vision_description = vision_response.choices[0].message.content
        user_message = f"[Image analysis: {vision_description}]\n\nUser message: {user_message}" if user_message else vision_description

    # Build history
    history = []
    for msg in history_input:
        if msg["role"] == "user":
            history.append(HumanMessage(content=msg["content"]))
        else:
            history.append(AIMessage(content=msg["content"]))

    # Get model
    model_name = MODELS.get(model_key, MODELS["inf1"])
    llm = ChatGroq(
        api_key=os.environ.get("GROQ_API_KEY"),
        model=model_name,
        temperature=0.7,
    )

    prompt = ChatPromptTemplate.from_messages([
        ("system", SYSTEM_PROMPT),
        MessagesPlaceholder(variable_name="chat_history"),
        ("human", "{input}"),
        MessagesPlaceholder(variable_name="agent_scratchpad"),
    ])

    agent = create_tool_calling_agent(llm, tools, prompt)
    agent_executor = AgentExecutor(agent=agent, tools=tools, verbose=False)

    response = agent_executor.invoke({
        "input": user_message,
        "chat_history": history,
    })
    reply = response["output"]

    # Save to Firestore if logged in
    if user_id and chat_id != "default":
        chat_ref = db.collection("users").document(user_id).collection("chats").document(chat_id)
        chat_doc = chat_ref.get()
        messages = chat_doc.to_dict().get("messages", []) if chat_doc.exists else []
        messages.append({"role": "user", "content": user_message})
        messages.append({"role": "assistant", "content": reply})
        chat_ref.set({
            "messages": messages,
            "title": messages[0]["content"][:50],
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

@app.route("/logout", methods=["POST"])
def logout():
    session.clear()
    return jsonify({"success": True})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)
