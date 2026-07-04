import react from "@vitejs/plugin-react";
import insider from "../dist/plugin.js";

export default {
  plugins: [insider(), react()],
};
