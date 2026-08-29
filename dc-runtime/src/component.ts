import { StreamableLogic } from './logic.js';
import { getReact, h } from './react.js';

function shallowEqual(a, b) {
  if (!b) return false;
  const ak = Object.keys(a).filter((k) => k !== "children");
  const bk = Object.keys(b).filter((k) => k !== "children");
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (a[k] !== b[k]) return false;
  return true;
}
export function Placeholder({
  name,
  hintSize,
  streaming,
  error
}) {
  const [w, hgt] = (hintSize || "100%,60px").split(",");
  return h(
    "div",
    {
      className: "sc-placeholder" + (streaming ? " sc-streaming" : ""),
      style: { width: w.trim(), height: hgt && hgt.trim() },
      title: name
    },
    error ? h(
      "div",
      { className: "sc-placeholder-error" },
      (name ? name + ": " : "") + error
    ) : null
  );
}
function hintToMin(hint) {
  if (!hint) return void 0;
  const [w, hgt] = hint.split(",");
  return { minWidth: w.trim(), minHeight: hgt && hgt.trim() };
}
export function createComponentFactory(registry, ensureFetched) {
  const React = getReact();
  const AncestorContext = React.createContext([]);
  class StreamableComponent extends React.Component {
    __name: any;
    __sub: any;
    __needsDidMount = false;
    /** Snapshot of the registry's streaming flags taken at render time —
     *  builders read it off the RenderCtx (this) to pick placeholder vs
     *  render-nothing for unresolved values. */
    __streamingNow = false;
    __htmlStreamingNow = false;
    /** When a construct throws, remember the (class, registry.ver, props)
     *  triple so render-time reconcile doesn't re-attempt it on every parent
     *  re-render. A registry bump (new class, template, external module
     *  resolving via bumpAll) changes `ver` and breaks the memo so an
     *  env-dependent constructor can self-heal. */
    __failedLogic: any = null;
    __failedUserProps: any = null;
    __failedVer = -1;
    /** Per-instance constructor error — kept here (not on the registry entry)
     *  so one instance's successful construct can't hide a sibling's failure,
     *  and a construct can never wipe an eval error `updateJs` recorded on
     *  `r.logicError`. */
    __ctorError: any = null;
    logic: any;
    constructor(props) {
      super(props);
      this.__name = props.__name;
      this.state = { __v: 0, __err: null };
      this.__sub = () => {
        if (this.state.__err) this.setState({ __err: null });
        this.forceUpdate();
      };
      this.__makeLogic(registry.get(this.__name).Logic, null);
      ensureFetched(this.__name);
    }
    /** Error-boundary hook: a render crash anywhere in this DC's subtree
     *  (its own template, an x-import'd component, a child DC without its
     *  own deeper boundary) lands here instead of unmounting the page. */
    static getDerivedStateFromError(e) {
      return { __err: e instanceof Error && e.message ? e.message : String(e) };
    }
    componentDidCatch(e, info) {
      console.error(
        "[dc-runtime] render error in <" + this.__name + ">:",
        e,
        info?.componentStack || ""
      );
    }
    /** Instantiate the logic class (or the no-op base) and adopt `prevState`
     *  over its initial state — used both at mount and on hot-swap. */
    __makeLogic(Logic, prevState) {
      const L = Logic || StreamableLogic;
      try {
        this.logic = new L(this.__userProps());
        this.__failedLogic = null;
        this.__failedUserProps = null;
        this.__ctorError = null;
      } catch (e) {
        console.error(e);
        this.__failedLogic = Logic;
        this.__failedUserProps = this.__userProps();
        this.__failedVer = registry.get(this.__name).ver;
        this.__ctorError = this.__name + ": " + (e instanceof Error && e.message ? e.message : String(e));
        this.logic = new StreamableLogic(
          this.__userProps()
        );
      }
      this.logic.__host = this;
      if (prevState)
        this.logic.state = { ...this.logic.state || {}, ...prevState };
    }
    /** The props the author's logic + template see — internal __-prefixed
     *  wiring stripped. */
    __userProps() {
      const { __name, __hintSize, __tplId, __hostStyle, ...rest } = this.props;
      return rest;
    }
    __setLogicState(update, cb) {
      const prev = this.logic.state;
      const patch = typeof update === "function" ? update(prev) : update;
      this.logic.state = { ...prev, ...patch };
      this.setState((s) => ({ __v: s.__v + 1 }), cb);
    }
    /** Swap the logic instance when the registry's Logic class changed
     *  (streaming completion, hot reload). State carries over; didMount
     *  re-fires after the swap commits so refs exist. */
    __reconcileLogic() {
      const r = registry.get(this.__name);
      const Next = r.Logic;
      const Cur = this.logic.constructor;
      if (Next === Cur || !Next && Cur === StreamableLogic || Next === this.__failedLogic && r.ver === this.__failedVer && shallowEqual(this.__userProps(), this.__failedUserProps)) {
        return;
      }
      if (!this.__needsDidMount) {
        try {
          this.logic.componentWillUnmount();
        } catch (e) {
          console.error(e);
        }
      }
      this.__makeLogic(Next, this.logic.state);
      this.__needsDidMount = true;
    }
    componentDidMount() {
      registry.get(this.__name).subs.add(this.__sub);
      try {
        this.logic.componentDidMount();
      } catch (e) {
        console.error(e);
      }
    }
    componentDidUpdate(prevProps) {
      this.logic.props = this.__userProps();
      if (this.__needsDidMount) {
        if (this.state.__err || !registry.get(this.__name).tpl) return;
        this.__needsDidMount = false;
        try {
          this.logic.componentDidMount();
        } catch (e) {
          console.error(e);
        }
      } else {
        try {
          this.logic.componentDidUpdate(prevProps);
        } catch (e) {
          console.error(e);
        }
      }
    }
    componentWillUnmount() {
      registry.get(this.__name).subs.delete(this.__sub);
      if (!this.__needsDidMount) {
        try {
          this.logic.componentWillUnmount();
        } catch (e) {
          console.error(e);
        }
      }
    }
    render() {
      const r = registry.get(this.__name);
      const cls = "sc-host" + (r.htmlStreaming ? " sc-streaming-html" : "") + (r.jsStreaming ? " sc-streaming-js" : "");
      const hintStyle = r.htmlStreaming ? hintToMin(this.props.__hintSize) : void 0;
      const hostStyle = this.props.__hostStyle || hintStyle ? { ...hintStyle || {}, ...this.props.__hostStyle || {} } : void 0;
      const hostBase = {
        className: cls,
        style: hostStyle,
        "data-sc-name": this.__name,
        "data-dc-tpl": this.props.__tplId
      };
      const chain = Array.isArray(this.context) ? this.context : [];
      if (chain.includes(this.__name)) {
        const cycle = [
          ...chain.slice(chain.indexOf(this.__name)),
          this.__name
        ].join(" \u2192 ");
        return h(
          "div",
          { ...hostBase, className: cls + " sc-has-error" },
          h(Placeholder, {
            name: this.__name,
            hintSize: this.props.__hintSize,
            error: "circular import: " + cycle
          })
        );
      }
      if (this.state.__err) {
        return h(
          "div",
          { ...hostBase, className: cls + " sc-has-error" },
          h(
            "div",
            { className: "sc-logic-error", "data-omelette-chrome": "" },
            this.__name + ": " + this.state.__err
          ),
          h(Placeholder, {
            name: this.__name,
            hintSize: this.props.__hintSize,
            error: this.state.__err
          })
        );
      }
      this.__reconcileLogic();
      if (!r.tpl) {
        return h(
          "div",
          hostBase,
          h(Placeholder, { name: this.__name, hintSize: this.props.__hintSize })
        );
      }
      const userProps = this.__userProps();
      this.logic.props = userProps;
      let vals = userProps;
      let renderErr = r.logicError || this.__ctorError;
      try {
        vals = { ...userProps, ...this.logic.renderVals() || {} };
      } catch (e) {
        console.error(e);
        renderErr = this.__name + ".renderVals(): " + (e instanceof Error && e.message ? e.message : String(e));
      }
      this.__streamingNow = !!(r.htmlStreaming || r.jsStreaming);
      this.__htmlStreamingNow = !!r.htmlStreaming;
      return h(
        "div",
        { ...hostBase, className: cls + (renderErr ? " sc-has-error" : "") },
        renderErr && h(
          "div",
          { className: "sc-logic-error", "data-omelette-chrome": "" },
          renderErr
        ),
        h(
          AncestorContext.Provider,
          { value: [...chain, this.__name] },
          r.tpl(vals, this)
        )
      );
    }

    static contextType = AncestorContext;
  }
  const named = /* @__PURE__ */ new Map();
  function getDC(name) {
    const hit = named.get(name);
    if (hit) return hit;
    function Dispatcher(p) {
      const [, setTick] = React.useState(0);
      React.useEffect(() => {
        const sub = () => setTick((n) => n + 1);
        registry.get(name).subs.add(sub);
        return () => {
          registry.get(name).subs.delete(sub);
        };
      }, []);
      ensureFetched(name);
      return h(StreamableComponent, { ...p, __name: name });
    }
    Dispatcher.displayName = name;
    named.set(name, Dispatcher);
    return Dispatcher;
  }
  return {
    getDC,
    StreamableComponent
  };
}
