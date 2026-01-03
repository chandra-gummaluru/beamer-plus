from typing import List, Tuple
import time

def summarize(responses: List[str], num_summaries: int) -> List[Tuple[str, int]]:
    """
    Summarize survey responses.
    
    Args:
        responses: List of response text strings
        num_summaries: Number of summaries to generate
        
    Returns:
        List of tuples containing (summary, num_respondents)
    """
    summaries = []
    responses_per_summary = len(responses) // num_summaries if num_summaries > 0 else len(responses)
    
    for i in range(num_summaries):
        summary = f"This is an example summary {i + 1} of the survey responses."
        num_respondents = responses_per_summary if i < num_summaries - 1 else len(responses) - (responses_per_summary * (num_summaries - 1))
        summaries.append((summary, num_respondents))
    
    time.sleep(5)
    return summaries
