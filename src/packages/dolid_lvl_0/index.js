import { createSignal, createEffect } from "./src";

const [count, setCount] = createSignal(0);

createEffect(() => {
  console.log("Change: " + count());
});

setInterval(() => {
  setCount((pref) => pref + 1);
}, 2000);
