from typing import List

def summarize(responses: List[str], num_summaries: int) -> List[str]:
    summaries = []
    for  i in range(num_summaries):
        summaries.append("Summary " + str(i))
    return summaries