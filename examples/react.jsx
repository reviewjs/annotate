// React integration — load annotate.js once at the app root.
//
// Drop <Annotate /> anywhere near the top of your tree (e.g. in App). It loads
// the CDN script a single time and configures it via window.AnnotateConfig.
//
// For Next.js (App Router), prefer next/script in app/layout.js — see README.

import { useEffect } from "react";

export default function Annotate({
  project = "my-react-app",
  accent = "#6d28d9",
  theme = "auto",
  src = "https://cdn.jsdelivr.net/npm/@reviewjs/annotate/annotate.js",
}) {
  useEffect(() => {
    if (document.getElementById("annotate-js")) return;
    window.AnnotateConfig = { project, accent, theme };
    const s = document.createElement("script");
    s.id = "annotate-js";
    s.src = src;
    s.defer = true;
    document.body.appendChild(s);
  }, [project, accent, theme, src]);

  return null;
}

// Usage:
//
//   import Annotate from "./Annotate";
//
//   export default function App() {
//     return (
//       <>
//         <Annotate project="marketing-site" accent="#10b981" />
//         {/* ...your app... */}
//       </>
//     );
//   }
