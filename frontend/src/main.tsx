import React from "react"
import { createRoot } from "react-dom/client"
import App from "./App"
import { setNativeAppearance } from "./bridge"
import "./styles.css"

const savedTheme = localStorage.getItem("boom-theme")
const initialTheme = savedTheme === "dark" ? "dark" : "light"
document.documentElement.dataset.theme = initialTheme
setNativeAppearance(initialTheme)

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
