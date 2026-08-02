# Surface adapter implementation notes

- The adapter targets Node 24.18.0 locally because the workstation default Node 22 cannot satisfy the approved Node 24 engine gate.
- Shared ports use Web `ReadableStream<Uint8Array>` so surface modules remain independent of Node and vendor SDK stream types.
- Threshold defaults remain configuration fields; the 30 MB Feishu upload ceiling is a protocol limit, not an operator tuning threshold.
- The public package exports one runtime value, `startFeishuSurface`; all other public exports are TypeScript types.
