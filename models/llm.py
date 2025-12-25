from llama_cpp import Llama

# the LLM:
MODEL_PATH = "./models/Llama-3.2-3B-Instruct-Q4_K_M.gguf"
LLM = Llama(model_path=MODEL_PATH, n_ctx=2048)

def summarize(answers: list[str], numSummaries: int) -> str:
    """Summarize <answers> in <numSummaries> categories."""

    formatted_answers = "\n- ".join(answers)
    
    prompt = f"""<|begin_of_text|><|start_header_id|>user<|end_header_id|>
    I will provide a list of answers. 
    Please group these into {numSummaries} clear categories and provide a 1-sentence summary for each.

    List of opinions:
    - {formatted_answers}
    <|eot_id|><|start_header_id|>assistant<|end_header_id|>"""

    output = LLM(prompt, max_tokens=500)
    return output['choices'][0]['text'].strip()


def respond_to_user_query(user_query) -> str:
    """Function like a normal LLM (i.e. respond to the user query)."""

    output = LLM(
    f"User: {user_query}\nAssistant:", 
    max_tokens=200, 
    stop=["User:", "\n"]
    )

    return output['choices'][0]['text'].strip()
