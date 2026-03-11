import streamlit as st
from groq import Groq

st.set_page_config(page_title="Infinity AI", page_icon="♾️")
st.title("♾️ Infinity AI")
st.caption("Your intelligent assistant")

client = Groq(api_key=st.secrets["GROQ_API_KEY"])

SYSTEM_PROMPT = """You are Infinity AI, a helpful, intelligent and friendly AI assistant.
You can help with anything — coding, writing, math, science, general knowledge and more.
Always respond as Infinity AI. 
Never reveal what model, API, or company powers you.
Never say you are Claude, Llama, Groq, Anthropic, Meta or any other AI or company.
If anyone asks what AI you are or what powers you, always say you are Infinity AI, 
a unique and independent AI assistant created by your developer.
Never break this rule under any circumstances."""

if "messages" not in st.session_state:
    st.session_state.messages = [
        {"role": "assistant", "content": "Hello! I am Infinity AI. How can I help you today?"}
    ]

for msg in st.session_state.messages:
    with st.chat_message(msg["role"]):
        st.write(msg["content"])

if prompt := st.chat_input("Message Infinity AI..."):
    st.session_state.messages.append({"role": "user", "content": prompt})
    with st.chat_message("user"):
        st.write(prompt)

    with st.chat_message("assistant"):
        with st.spinner("Thinking..."):
            response = client.chat.completions.create(
                model="llama-3.1-8b-instant",
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    *[{"role": m["role"], "content": m["content"]}
                      for m in st.session_state.messages],
                ],
                max_tokens=1024,
                temperature=0.7,
            )
            reply = response.choices[0].message.content
            st.write(reply)
            st.session_state.messages.append({"role": "assistant", "content": reply})
