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

def summarize(responses: List[str], num_summaries: int) -> List[Tuple[str, int]]:
    """
    Summarize survey responses.

    Args:
        responses: List of response text strings
        num_summaries: Number of summaries to generate

    Returns:
        List of tuples containing (summary, num_respondents)
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
            f"Summarize the main theme in these survey responses in one concise sentence. "
            f"Do not use quotation marks. Be direct and factual. "
            f"Responses:\n{text}"
        )

        result = summarizer(
            prompt,
            max_length=150,
            min_length=50,
            do_sample=False
        )[0]["summary_text"]

        # Clean up the summary - remove quotes and extra whitespace
        summary_text = result.strip().strip('"\'')
        
        summaries.append((summary_text, len(chunk)))

    # Optional: simulate latency
    time.sleep(1)
    return summaries
