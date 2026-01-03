from typing import List, Tuple
import os
from openai import OpenAI

# Create OpenAI client (API key picked up from environment by default)
client = OpenAI()

if not os.getenv("OPENAI_API_KEY"):
    raise ValueError("OPENAI_API_KEY environment variable not set")


def summarize(responses: List[str], num_summaries: int) -> List[Tuple[str, int]]:
    """
    Summarize survey responses by grouping them into `num_summaries` thematic clusters.
    Returns one concise summary sentence per group (max 280 characters) and the count
    of responses in that group, as (summary, count) tuples.

    Args:
        responses: List of response text strings
        num_summaries: Number of thematic summaries to generate

    Returns:
        List of tuples (summary, count)
    """
    if num_summaries <= 0 or not responses:
        return []

    text = "\n".join([f"- {resp}" for resp in responses])

    prompt = f"""You are analyzing a large set of survey responses.

Task:
1. Group these responses into exactly {num_summaries} distinct thematic clusters.
2. For each group, write ONE concise summary sentence capturing the main idea.
3. Summaries must be factual, neutral, consistent in tone, and under 280 characters.
4. Include the count of responses in each group.
5. Do NOT use quotation marks or phrases like "Respondents said" or "This group shows".
6. Return ONLY a Python-style list of tuples in this format:

(summary, count)

Survey responses ({len(responses)} total):
{text}

Begin.
"""

    try:
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are a concise survey analyst. You summarize survey responses "
                        "by grouping them into thematic clusters. Write one clear, factual, "
                        "summary (2-3 sentences) per group and include the count of responses. "
                        "Return ONLY a Python-style list of tuples: (summary, count)."
                    ),
                },
                {
                    "role": "user",
                    "content": prompt,
                },
            ],
            max_tokens=1200,
            temperature=0.7,
            top_p=1.0,
            frequency_penalty=0.0,
            presence_penalty=0.0,
        )

        result_text = response.choices[0].message.content.strip()

        # Evaluate the Python-style list safely
        summaries: List[Tuple[str, int]] = []
        try:
            # Only evaluate if it looks like a list of tuples
            if result_text.startswith("[") and result_text.endswith("]"):
                summaries = eval(result_text)  # safe-ish since we control the prompt
                # Ensure types
                summaries = [(str(s), int(c)) for s, c in summaries]
        except Exception:
            # Fallback: return as a single error tuple
            summaries = [(f"Error parsing model output: {result_text}", len(responses))]

        return summaries

    except Exception as e:
        print(f"OpenAI API error: {e}")
        return [(f"Error generating summaries: {e}", len(responses))]
