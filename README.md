# Robot Replay Studio

Robot Replay Studio replays mobile-robot telemetry in the browser. The incident rail, spatial view,
detector panel, timeline, and signal charts share one mission clock. A candidate run can be compared
with an optional baseline.

Imported recordings stay in the browser. The application has no backend, upload step, analytics, or
account system.

## Use it

1. Open a built-in case or import a recording.
2. Select an incident in the rail or timeline.
3. Inspect the crossing in **Detector**, the underlying values in **Sample**, and the active limits
   in **Rule**.
4. Use **Fault Lab** to try a dropout, pose reset, or motor-load change without replacing the
   current run.
5. Export a JSON report, Markdown brief, or print view when needed.

The spatial view shows the planned route, safety corridor, candidate path, optional baseline,
obstacles, uncertainty, and selected incident. Signal charts cover speed, path error, motor current,
and link latency/data age. Missing-data intervals remain visible instead of being interpolated.

## Inputs

- Session JSON with a candidate run and optional baseline
- CSV with `timestamp,x,y,yaw` plus optional telemetry columns
- ROS-bridge JSONL with `/odom` and optional battery or diagnostic messages
- Live telemetry from the local simulator or a WebSocket selected by the operator

CSV imports accept optional `sequence,speed,battery,current,state,latency_ms,pose_sigma` columns.
Time and yaw units are selected in the import dialog. The browser reports malformed rows and missing
required fields directly in that dialog.

## Run locally

Requires Node.js and npm.

```bash
npm install
npm run dev
```

Open the local address printed in the terminal.

Robot Replay Studio is an investigation interface, not a robot controller, SLAM system, or safety
certification tool.
