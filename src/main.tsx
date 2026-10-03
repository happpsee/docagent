import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";

// 设计系统用 .dark 类切换主题，这里跟随系统
const mq = window.matchMedia("(prefers-color-scheme: dark)");
const apply = () => document.documentElement.classList.toggle("dark", mq.matches);
apply();
mq.addEventListener("change", apply);

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
