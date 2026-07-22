# Metrics

Metrics are derived only from the spans created for the same terminal turn and are uploaded once with OTLP Delta temporality.

| Metric | Type | Unit | Source |
| --- | --- | --- | --- |
| `gen_ai.workflow.duration` | Histogram | `s` | `invoke_agent` |
| `gen_ai.agent.operation.count` | Sum | empty | each `llm`, `tool:*`, `skill:*` |
| `gen_ai.agent.operation.duration` | Histogram | `ms` | each `llm`, `tool:*`, `skill:*` |
| `gen_ai.client.token.usage` | Histogram | `{token}` | input/output usage on `llm` only |

Each count data point has value `1`. Each histogram point has `count=1`, and `sum`, `min`, and `max` equal the observed value. Bucket boundaries match the gtrace semantic-conventions repository.

Assistant spans do not emit metrics. Root aggregate usage is not used for token metrics, preventing duplicated token accounting.
