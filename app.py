from flask import Flask, request, jsonify, render_template, session
from flask_session import Session
from langchain_groq import ChatGroq
from langchain.agents import AgentExecutor, create_tool_calling_agent
from langchain_community.tools import DuckDuckGoSearchRun
from langchain.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain.memory import ConversationBufferMemory
from langchain_core.messages import HumanMessage, AIMessage
import firebase_admin
from firebase_admin import credentials, firestore, auth
import os, json

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "infinity-ai-secret")
app.config["SESSION_TYPE"] = "filesystem"
Session(app)

# Firebase setup
cred_dict = json.loads(os.environ.get("FIREBASE_CREDENTIALS", "{}"))
if not firebase_admin._apps:
    cred = credentials.Certificate(cred_dict)
    firebase_admin.initialize_app(cred)
db = firestore.client()

# LangChain setup
llm = ChatGroq(
    api_key=os.environ.get("GROQ_API_KEY"),
    model="llama-3.3-70b-versatile",
    temperature=0.7,
)

search = DuckDuckGoSearchRun()
tools = [search]

prompt = ChatPromptTemplate.from_messages([
    ("system", """You are Infinity AI, a helpful, intelligent and friendly AI assistant.
You can help with anything — coding, writing, math, science, general knowledge and more.
You have access to web search for recent information — use it when needed.
Always respond as Infinity AI. Never reveal what model, API, or company powers you.
Never say you are Claude, Llama, Groq, Anthropic, Meta or any other AI or company.
If anyone asks what AI you are, always say you are Infinity AI, a unique and independent AI assistant."""),
    MessagesPlaceholder(variable_name="chat_history"),
    ("human", "{input}"),
    MessagesPlaceholder(variable_name="agent_scratchpad"),
])

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
        session["user_email"] = decoded.get("email", "")
        session["user_photo"] = decoded.get("picture", "")
        return jsonify({"success": True, "name": session["user_name"]})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)})

@app.route("/chat", methods=["POST"])
def chat():
    if "user_id" not in session:
        return jsonify({"error": "Not logged in"}), 401

    user_message = request.json.get("message", "")
    chat_id = request.json.get("chat_id", "default")
    user_id = session["user_id"]

    # Load chat history from Firestore
    chat_ref = db.collection("users").document(user_id).collection("chats").document(chat_id)
    chat_doc = chat_ref.get()
    history = []
    if chat_doc.exists:
        messages = chat_doc.to_dict().get("messages", [])
        for msg in messages:
            if msg["role"] == "user":
                history.append(HumanMessage(content=msg["content"]))
            else:
                history.append(AIMessage(content=msg["content"]))

    # Create agent with memory
    agent = create_tool_calling_agent(llm, tools, prompt)
    agent_executor = AgentExecutor(agent=agent, tools=tools, verbose=False)

    # Run agent
    response = agent_executor.invoke({
        "input": user_message,
        "chat_history": history,
    })
    reply = response["output"]

    # Save to Firestore
    messages = chat_doc.to_dict().get("messages", []) if chat_doc.exists else []
    messages.append({"role": "user", "content": user_message})
    messages.append({"role": "assistant", "content": reply})
    chat_ref.set({
        "messages": messages,
        "title": messages[0]["content"][:50] if messages else "New Chat",
        "updated_at": firestore.SERVER_TIMESTAMP,
    })

    return jsonify({"response": reply})

@app.route("/get_chats", methods=["GET"])
def get_chats():
    if "user_id" not in session:
        return jsonify({"error": "Not logged in"}), 401
    user_id = session["user_id"]
    chats_ref = db.collection("users").document(user_id).collection("chats")
    chats = []
    for doc in chats_ref.stream():
        data = doc.to_dict()
        chats.append({"id": doc.id, "title": data.get("title", "New Chat")})
    return jsonify({"chats": chats})

@app.route("/get_chat/<chat_id>", methods=["GET"])
def get_chat(chat_id):
    if "user_id" not in session:
        return jsonify({"error": "Not logged in"}), 401
    user_id = session["user_id"]
    chat_ref = db.collection("users").document(user_id).collection("chats").document(chat_id)
    chat_doc = chat_ref.get()
    if chat_doc.exists:
        return jsonify({"messages": chat_doc.to_dict().get("messages", [])})
    return jsonify({"messages": []})

@app.route("/new_chat", methods=["POST"])
def new_chat():
    if "user_id" not in session:
        return jsonify({"error": "Not logged in"}), 401
    import uuid
    chat_id = str(uuid.uuid4())
    return jsonify({"chat_id": chat_id})

@app.route("/logout", methods=["POST"])
def logout():
    session.clear()
    return jsonify({"success": True})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)
