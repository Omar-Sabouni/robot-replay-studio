import "./styles.css";

import { startRobotReplayStudio } from "./studio";

const app = document.querySelector<HTMLDivElement>("#app");

if (app === null) {
  throw new Error("Application mount point not found");
}

void startRobotReplayStudio(app);
