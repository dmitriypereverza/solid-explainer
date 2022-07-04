import { render, insert, template, delegateEvents } from "./web";
import {
  createSignal,
  onCleanup,
  createComponent,
  createEffect,
} from "./src";

const _tmpl$ = /*#__PURE__*/ template(
  `<div><div>Count value is </div><button>Increment</button></div>`,
  6
);

const CountingComponent = () => {
  const [count, setCount] = createSignal(0);
  createEffect(() => {
    console.log("Change: " + count());
  });

  return (() => {
    const _el$ = _tmpl$.cloneNode(true),
      _el$2 = _el$.firstChild;

    const _el$4 = _el$2.nextSibling;

    insert(_el$2, count, null);
    _el$4.$$click = () => setCount(count() + 1);
    return _el$;
  })();
};

render(
  () => createComponent(CountingComponent, {}),
  document.getElementById("app")
);

delegateEvents(["click"]);
