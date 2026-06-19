<!--
  Vue 3 integration — load annotate.js once when the root component mounts.

  Use this component anywhere in your app (typically in App.vue). It injects the
  CDN script a single time and configures it via window.AnnotateConfig.

  Alternatively, just add the <script> tag directly to your index.html before
  </body> — no component needed.
-->
<script setup>
import { onMounted } from "vue";

const props = defineProps({
  project: { type: String, default: "my-vue-app" },
  accent: { type: String, default: "#10b981" },
  theme: { type: String, default: "auto" },
  src: {
    type: String,
    default: "https://cdn.jsdelivr.net/npm/@reviewjs/annotate/annotate.js",
  },
});

onMounted(() => {
  if (document.getElementById("annotate-js")) return;
  window.AnnotateConfig = {
    project: props.project,
    accent: props.accent,
    theme: props.theme,
  };
  const s = document.createElement("script");
  s.id = "annotate-js";
  s.src = props.src;
  s.defer = true;
  document.body.appendChild(s);
});
</script>

<template>
  <!-- renders nothing; it only loads the library -->
</template>

<!--
  Usage in App.vue:

    <script setup>
    import Annotate from "./components/Annotate.vue";
    </script>

    <template>
      <Annotate project="marketing-site" accent="#6d28d9" />
      <!-- ...your app... -->
    </template>
-->
