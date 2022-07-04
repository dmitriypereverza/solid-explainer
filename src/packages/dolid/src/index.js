const equalFn = (a, b) => a === b;

const signalOptions = {
  equals: equalFn,
};

let ERROR = null;
let runEffects = runUserEffects;

const NOTPENDING = {};
const STALE = 1;
const PENDING = 2;
const UNOWNED = {
  owned: null,
  cleanups: null,
  context: null,
  owner: null,
};

/** Контекст выполнения */
var Owner = null;
/** Текущий контекст выполнения */
let Listener = null;
/** Аккумулятор изменений во время батчинга */
let Pending = null;
/** Чистые обновления (setState) */
let Updates = null;
/** Обновления, которые могут породить новые вычисления */
let Effects = null;
let ExecCount = 0;

/**
 * Creates a new non-tracked owner scope that doesn't auto-dispose.
 * This is useful for nested reactive scopes that you do not wish
 * to release when the parent re-evaluates.
 */
function createRoot(fn) {
  const listener = Listener,
    owner = Owner,
    unowned = fn.length === 0,
    root = unowned
      ? UNOWNED
      : {
          owned: null,
          cleanups: null,
          context: null,
          owner,
        },
    updateFn = unowned ? fn : () => fn(() => cleanNode(root));
  Owner = root;
  Listener = null;
  try {
    return runUpdates(updateFn, true);
  } finally {
    Listener = listener;
    Owner = owner;
  }
}

/**
 * Signals are the most basic reactive primitive.
 * They track a single value (which can be any JavaScript object)
 * that changes over time.
 */
function createSignal(value, options) {
  options = options ? Object.assign({}, signalOptions, options) : signalOptions;
  const s = {
    /** Внутренне значение сигнала  */
    value,
    /** Слушатели сигнала */
    observers: null,
    /** Индексы слушателей */
    observerSlots: null,
    /** Вычисляется ли уже? */
    pending: NOTPENDING,
    /** Ф-ция сравнения значений  */
    comparator: options.equals || undefined,
  };
  const setter = (value) => {
    if (typeof value === "function") {
      value = value(s.pending !== NOTPENDING ? s.pending : s.value);
    }
    return writeSignal(s, value);
  };
  return [readSignal.bind(s), setter];
}

/**
 * Effects are a general way to make arbitrary
 * code ("side effects") run whenever dependencies
 * change, e.g., to modify the DOM manually.
 * CreateEffect creates a new computation that
 * runs the given function in a tracking scope,
 * thus automatically tracking its dependencies,
 * and automatically reruns the function whenever
 * the dependencies update.
 */
function createEffect(fn, value) {
  const c = createComputation(fn, value, false, STALE);
  c.user = true;
  Effects ? Effects.push(c) : updateComputation(c);
}

/**
 * A render effect is a computation similar to a regular effect (as created by createEffect),
 * but differs in when Solid schedules the first execution of the effect function.
 * While createEffect waits for the current rendering phase to be complete, createRenderEffect immediately calls the function
 * */
function createRenderEffect(fn, value) {
  const c = createComputation(fn, value, false, STALE);
  updateComputation(c);
}

/** Создает вычисляемое значение, это одновременно и signal и computation */
function createMemo(fn, value, options) {
  options = options ? Object.assign({}, signalOptions, options) : signalOptions;
  const c = createComputation(fn, value, true, 0);
  c.pending = NOTPENDING;
  c.observers = null;
  c.observerSlots = null;
  c.comparator = options.equals || undefined;
  updateComputation(c);
  return readSignal.bind(c);
}

/** Группирует вычисления и после разом их применяет */
function batch(fn) {
  if (Pending) return fn();
  let result;
  const q = (Pending = []);
  try {
    result = fn();
  } finally {
    Pending = null;
  }
  runUpdates(() => {
    for (let i = 0; i < q.length; i += 1) {
      const data = q[i];
      if (data.pending !== NOTPENDING) {
        const pending = data.pending;
        data.pending = NOTPENDING;
        writeSignal(data, pending);
      }
    }
  }, false);
  return result;
}

/** Регистрирует ф-цию очистки */
function onCleanup(fn) {
  if (Owner === null);
  else if (Owner.cleanups === null) Owner.cleanups = [fn];
  else Owner.cleanups.push(fn);
  return fn;
}

/**
 * Calling the getter (e.g., count() or ready()) returns the current value of the Signal.
 * Crucial to automatic dependency tracking, calling the getter within a tracking scope causes
 * the calling function to depend on this Signal, so that function will rerun if the Signal gets updated.
 */
function readSignal() {
  if (this.sources && this.state) {
    const updates = Updates;
    Updates = null;
    this.state === STALE ? updateComputation(this) : lookUpstream(this);
    Updates = updates;
  }
  if (Listener) {
    const sSlot = this.observers ? this.observers.length : 0;
    if (!Listener.sources) {
      Listener.sources = [this];
      Listener.sourceSlots = [sSlot];
    } else {
      Listener.sources.push(this);
      Listener.sourceSlots.push(sSlot);
    }
    if (!this.observers) {
      this.observers = [Listener];
      this.observerSlots = [Listener.sources.length - 1];
    } else {
      this.observers.push(Listener);
      this.observerSlots.push(Listener.sources.length - 1);
    }
  }
  return this.value;
}

/**
 * Calling the setter (e.g., setCount(nextCount) or setReady(nextReady)) sets
 * the Signal's value and updates the Signal (triggering dependents to rerun) if the value actually changed (see details below).
 * As its only argument, the setter takes either the new value for the signal,
 * or a function that maps the last value of the signal to a new value.
 * The setter also returns the updated value.
 */
function writeSignal(node, value) {
  if (Pending) {
    if (node.pending === NOTPENDING) Pending.push(node);
    node.pending = value;
    return value;
  }
  if (node.comparator && node.comparator(node.value, value)) {
    return value;
  }
  node.value = value;
  if (node.observers && node.observers.length) {
    runUpdates(() => {
      for (let i = 0; i < node.observers.length; i += 1) {
        const o = node.observers[i];
        if (!o.state) {
          if (o.pure) Updates.push(o);
          else Effects.push(o);
          if (o.observers) markDownstream(o);
        }
        o.state = STALE;
      }
      if (Updates.length > 10e5) {
        Updates = [];
      }
    }, false);
  }
  return value;
}

function createComputation(fn, init, pure, state = STALE) {
  const c = {
    fn,
    /** Состояние */
    state: state,
    updatedAt: null,
    /** Родитель данного вычисления */
    owned: null,
    /** За какими значениями наблюдает computation */
    sources: null,
    /** Индекс источника */
    sourceSlots: null,
    /** Ф-ции очистки (onCleanup) */
    cleanups: null,
    /** Возвращаемое значение для вычисления */
    value: init,
    /** Владелец вычисления */
    owner: Owner,
    /** Чистое ли вычисление. Или может ли при выполнении вычисления добавиться новые зависимости */
    context: null,
    pure,
  };
  if (Owner === null);
  else if (Owner !== UNOWNED) {
    if (!Owner.owned) Owner.owned = [c];
    else Owner.owned.push(c);
  }
  return c;
}

/**
 * Сбрасываем подписки по ноде, так как зависимости нужно пересчитать.
 * И запускает вычисление.
 */
function updateComputation(node) {
  if (!node.fn) return;
  cleanNode(node);
  const owner = Owner,
    listener = Listener,
    time = ExecCount;
  Listener = Owner = node;
  runComputation(node, node.value, time);
  Listener = listener;
  Owner = owner;
}

/** Выполняем вычисление и оповещает всех что подписан на него */
function runComputation(node, value, time) {
  let nextValue;
  try {
    nextValue = node.fn(value);
  } catch (err) {
    handleError(err);
  }
  if (!node.updatedAt || node.updatedAt <= time) {
    if (node.observers && node.observers.length) {
      writeSignal(node, nextValue, true);
    } else node.value = nextValue;
    node.updatedAt = time;
  }
}

function runTop(node) {
  if (node.state === 0) return;
  if (node.state === PENDING) {
    return lookUpstream(node);
  }
  const ancestors = [node];
  while (
    (node = node.owner) &&
    (!node.updatedAt || node.updatedAt < ExecCount)
  ) {
    // if node.state equal STALE or PENDING
    if (node.state) ancestors.push(node);
  }
  for (let i = ancestors.length - 1; i >= 0; i--) {
    node = ancestors[i];
    if (node.state === STALE) {
      updateComputation(node);
    } else if (node.state === PENDING) {
      const updates = Updates;
      Updates = null;
      lookUpstream(node, ancestors[0]);
      Updates = updates;
    }
  }
}

/**
 * Создает контекст для обновлений и после выполнения колбэка применяет изменения
 */
function runUpdates(fn, init) {
  if (Updates) return fn();
  let wait = false;
  if (!init) Updates = [];
  if (Effects) wait = true;
  else Effects = [];
  ExecCount++;
  try {
    const res = fn();
    completeUpdates(wait);
    return res;
  } catch (err) {
    handleError(err);
  } finally {
    Updates = null;
    if (!wait) Effects = null;
  }
}

function runQueue(queue) {
  for (let i = 0; i < queue.length; i++) runTop(queue[i]);
}

function completeUpdates(wait) {
  if (Updates) {
    runQueue(Updates);
    Updates = null;
  }
  if (wait) return;
  let res;
  if (Effects.length)
    batch(() => {
      runEffects(Effects);
      Effects = null;
    });
  else {
    Effects = null;
  }
  if (res) res();
}

function runUserEffects(queue) {
  let i,
    userLength = 0;
  for (i = 0; i < queue.length; i++) {
    const e = queue[i];
    if (!e.user) runTop(e);
    else queue[userLength++] = e;
  }
  const resume = queue.length;
  for (i = 0; i < userLength; i++) runTop(queue[i]);
  for (i = resume; i < queue.length; i++) runTop(queue[i]);
}

function lookUpstream(node, ignore) {
  node.state = 0;

  for (let i = 0; i < node.sources.length; i += 1) {
    const source = node.sources[i];
    if (source.sources) {
      if (source.state === STALE) {
        if (source !== ignore) runTop(source);
      } else if (source.state === PENDING) lookUpstream(source, ignore);
    }
  }
}

function markDownstream(node) {
  for (let i = 0; i < node.observers.length; i += 1) {
    const o = node.observers[i];
    if (!o.state) {
      o.state = PENDING;
      if (o.pure) Updates.push(o);
      else Effects.push(o);
      o.observers && markDownstream(o);
    }
  }
}

function cleanNode(node) {
  let i;
  if (node.sources) {
    while (node.sources.length) {
      const source = node.sources.pop(),
        index = node.sourceSlots.pop(),
        obs = source.observers;
      if (obs && obs.length) {
        const observer = obs.pop(),
          observerSlot = source.observerSlots.pop();
        if (index < obs.length) {
          observer.sourceSlots[observerSlot] = index;
          obs[index] = observer;
          source.observerSlots[index] = observerSlot;
        }
      }
    }
  }
  if (node.owned) {
    for (i = 0; i < node.owned.length; i++) cleanNode(node.owned[i]);
    node.owned = null;
  }
  if (node.cleanups) {
    for (i = 0; i < node.cleanups.length; i++) node.cleanups[i]();
    node.cleanups = null;
  }
  node.state = 0;
}

/**
 * onError - run an effect whenever an error is thrown within the context of the child scopes
 * @param fn an error handler that receives the error
 *
 * * If the error is thrown again inside the error handler, it will trigger the next available parent handler
 *
 * @description https://www.solidjs.com/docs/latest/api#onerror
 */
function onError(fn) {
  ERROR || (ERROR = Symbol("error"));
  if (Owner === null);
  else if (Owner.context === null) Owner.context = { [ERROR]: [fn] };
  else if (!Owner.context[ERROR]) Owner.context[ERROR] = [fn];
  else Owner.context[ERROR].push(fn);
}

function handleError(err) {
  const fns = ERROR && Owner && Owner.context[ERROR];
  if (!fns) throw err;
  fns.forEach((f) => f(err));
}

/**
 * Выполняем ф-цию без внешних слушателей.
 *
 * Ignores tracking any of the dependencies
 * in the executing code block and returns the value.
 * */
function untrack(fn) {
  let result,
    listener = Listener;
  Listener = null;
  result = fn();
  Listener = listener;
  return result;
}

function createComponent(Comp, props) {
  return untrack(() => Comp(props || {}));
}

export {
  createRenderEffect,
  createRoot,
  createComponent,
  createSignal,
  onCleanup,
  onError,
  createEffect,
  createMemo,
};
