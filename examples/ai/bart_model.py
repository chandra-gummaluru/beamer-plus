from typing import List, Tuple
from transformers import pipeline
import math
import time

# Load summarization model
summarizer = pipeline(
    task="summarization",
    model="facebook/bart-large-cnn",
    device=-1
)

def summarize(responses: List[str], num_summaries: int) -> List[Tuple[str, str, int]]:
    """
    Summarize survey responses with each summary formatted as '<Title>: <Summary>'.

    Args:
        responses: List of response text strings
        num_summaries: Number of summaries to generate

    Returns:
        List of tuples containing (title, summary, num_respondents)
    """
    if num_summaries <= 0 or not responses:
        return []

    summaries = []
    chunk_size = math.ceil(len(responses) / num_summaries)

    for i in range(num_summaries):
        chunk = responses[i * chunk_size:(i + 1) * chunk_size]
        if not chunk:
            break

        # Combine responses into a single document
        text = " ".join(chunk)

        # Instruction for the model
        prompt = (
            f"Summarize the following survey responses. "
            f"Always format the output as '<Title>: <Summary>'. "
            f"Responses:\n{text}"
        )

        result = summarizer(
            prompt,
            max_length=150,
            min_length=50,
            do_sample=False
        )[0]["summary_text"]

        # Attempt to split title and summary
        if ":" in result:
            title, summary_text = result.split(":", 1)
        else:
            # fallback if the model ignores the format
            title = f"Theme {i + 1}"
            summary_text = result.strip()

        summaries.append((title.strip(), summary_text.strip(), len(chunk)))

    # Optional: simulate latency
    time.sleep(1)
    return summaries
