const equalFn = (a, b) => a === b;

const signalOptions = {
  equals: equalFn,
};

let ERROR = null;

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
 * Сигналы являются самым основным реактивным примитивом.
 * Они отслеживают одно значение, которое изменяется с течением времени.
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
    /** Уже вычисленное но не примененное значение */
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
 * Вызов геттера (например, count() или ready()) возвращает текущее значение сигнала.
 * Для автоматического отслеживания зависимостей вызов геттера в области отслеживания приводит к тому,
 * что вызывающая функция зависит от этого сигнала, поэтому эта функция будет перезапущена, если сигнал будет обновлен.
 */
function readSignal() {
  // Если у сигнала есть sources, значит он создан через useMemo.
  if (this.sources && this.state) {
    const updates = Updates;
    Updates = null;
    updateComputation(this);
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
 * Вызов установщика (например, setCount(nextCount) или setReady(nextReady)) устанавливает значение сигнала
 * и обновляет сигнал (запуская повторный запуск зависимых элементов), если значение действительно изменилось.
 * В качестве единственного аргумента сеттер принимает либо новое значение сигнала,
 * либо функцию, которая отображает последнее значение сигнала в новое значение.
 * Сеттер также возвращает обновленное значение.
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
          // Пробегаемся вглубь по подпискам и добавляем их в Updates и Effects
          if (o.observers) markDownstream(o);
        }
        o.state = STALE;
      }
      // Если кол-во простых реакций будет больше 1 млн.то Solid из просто сбрасывает. Странно, похоже защита от дурака.
      if (Updates.length > 10e5) {
        Updates = [];
      }
    }, false);
  }
  return value;
}

function markDownstream(node) {
  for (let i = 0; i < node.observers.length; i += 1) {
    const o = node.observers[i];
    if (!o.state) {
      // Если слушатель ноды свежий (не обработан), то помечаем его состояние как вычисляемое
      o.state = PENDING;
      if (o.pure) Updates.push(o);
      else Effects.push(o);
      o.observers && markDownstream(o);
    }
  }
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

/**
 * Эффекты — это общий способ запуска произвольного кода всякий раз, когда изменяются зависимости,
 * например, для изменения DOM вручную.
 * CreateEffect создает новое вычисление, которое запускает данную функцию в области отслеживания,
 * тем самым автоматически отслеживая ее зависимости, и автоматически перезапускает функцию при каждом обновлении зависимостей.
 */
function createEffect(fn, value) {
  const c = createComputation(fn, value, false, STALE);
  c.user = true;
  Effects ? Effects.push(c) : updateComputation(c);
}

/**
 *  Создает объект реактивного контекста.
 *  Будет перезапускать контекст при изменении каких либо его зависимостей.
 */
function createComputation(fn, init, pure, state = STALE) {
  const c = {
    fn,
    /**
     * Состояние:
     * - не обработано (0 = NOT_STALE)
     * - уже обработано (1 = STALE)
     * - в процессе обработки (2 = PENDING)
     */
    state: state,
    /** На какой итерации был обновлено */
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
 * Сбрасываем подписки реактивного контекста, так как зависимости нужно пересчитать.
 * И запускает вычисление.
 */
function updateComputation(node) {
  if (!node.fn) return;
  cleanNode(node);
  const owner = Owner,
    listener = Listener,
    time = ExecCount;
  // Выставляем текущее вычисление как слушателя реактивных событий
  Listener = Owner = node;
  runComputation(node, node.value, time);
  Listener = listener;
  Owner = owner;
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

function completeUpdates(wait) {
  if (Updates) {
    runQueue(Updates);
    Updates = null;
  }
  // Если Effects уже есть то откладываем их выполнение на потом
  if (wait) return;
  if (Effects.length)
    batch(() => {
      runUserEffects(Effects);
      Effects = null;
    });
  else {
    Effects = null;
  }
}

function runQueue(queue) {
  for (let i = 0; i < queue.length; i++) runTop(queue[i]);
}

/** Группирует вычисления и после разом их применяет */
function batch(fn) {
  if (Pending) return fn(); // Уже в batch ф-ции? Если да то Pending = [...]
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

/**
 * onError — запускать эффект всякий раз, когда возникает ошибка в контексте дочерних областей.
 * Если ошибка возникает снова внутри обработчика ошибок, она запускает следующий доступный родительский обработчик.
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

export { createSignal, createEffect, createMemo, onError };
