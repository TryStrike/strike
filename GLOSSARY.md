# Strike

Binary options on Arc with USDC settlement, where a trader can hand a budget to an agent and watch what it does.

## Language

**Agent**:
The server-side trader that acts inside the limits a trader signed for one session.
_Avoid_: Bot, AI, copilot

**Copilot**:
The assistant inside an agent session that shows what the agent is doing and answers questions about it. It can never place a bet, change a limit or move funds.
_Avoid_: Agent, assistant

**Decision**:
One outcome of the agent looking at the market: placed, awaiting, skipped, blocked or rejected.
_Avoid_: Trade, signal

**Decision trace**:
The real steps behind one decision, recorded as they happened.
_Avoid_: Thinking, reasoning, chain of thought

**Jev confidence**:
Jev's score from 0 to 1 for a proposal. It is an opinion, never a win chance.
_Avoid_: Win chance, probability

**Watcher**:
The copilot's read-only run during a yolo session that thinks about decisions as they happen. It never affects a trade.
_Avoid_: Narrator, second agent

**Explanation**:
The copilot's account of a decision, written after it happened, from the decision trace.
_Avoid_: Thinking, reasoning
