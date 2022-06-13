import { render, insert, template } from './packages/dolid/web';
import { createSignal, onCleanup, createComponent } from './packages/dolid/src';

const _tmpl$ = /*#__PURE__*/template(`<div>Count value is </div>`, 2);

const CountingComponent = () => {
  const [count, setCount] = createSignal(0);
  const [count2, setCount2] = createSignal(2);
  const interval = setInterval(() => {
    setCount(c => c + 1);
    setCount2(c => c + 2);
  }, 1000);
  onCleanup(() => clearInterval(interval));
  return (() => {
    const _el$ = _tmpl$.cloneNode(true),
          _el$2 = _el$.firstChild;

    insert(_el$, count2, _el$2);
    insert(_el$, count, null);

    return _el$;
  })();
};

render(() => createComponent(CountingComponent, {}), document.getElementById("app"));
