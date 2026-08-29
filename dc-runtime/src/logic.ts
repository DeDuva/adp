import { getReact } from './react.js';

export const StreamableLogic = class {
  props: any;
  state: any = {};
  /** Back-pointer to the wrapper component, installed after construction. */
  __host: any;
  constructor(props) {
    this.props = props || {};
  }
  setState(update, cb) {
    this.__host && this.__host.__setLogicState(update, cb);
  }
  forceUpdate() {
    this.__host && this.__host.forceUpdate();
  }
  componentDidMount() {
  }
  componentDidUpdate(_prevProps) {
  }
  componentWillUnmount() {
  }
  /** The flat object the template renders against (merged over props). */
  renderVals() {
    return {};
  }
};
export function evalDcLogic(src) {
  //! nosemgrep: eval-and-function-constructor
  const fn = new Function(
    "DCLogic",
    "StreamableLogic",
    "React",
    src + '\n;return (typeof Component!=="undefined"&&Component)||undefined;'
  );
  return fn(StreamableLogic, StreamableLogic, getReact());
}
