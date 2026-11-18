---
type: fixed
tim: TIM-0149
---
A task whose agent finished its turn but ignored both requests to close it is now closed as done when the agent goes idle, instead of being run again from the start; a review closed this way has no verdict and waits for a decision.
