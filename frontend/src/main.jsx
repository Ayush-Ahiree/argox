import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyTheme, initialTheme } from "./theme.jsx";
import "./theme.css";

applyTheme(initialTheme());

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
