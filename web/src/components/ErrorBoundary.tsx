import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Keeps a single failing widget (or view) from blanking a wall display: shows a small notice
 * and retries automatically, since most failures are transient data-shape surprises.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; label?: string }, { error: Error | null }> {
  state = { error: null as Error | null };
  private timer: ReturnType<typeof setTimeout> | null = null;

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[${this.props.label ?? 'view'}]`, error, info.componentStack);
    this.timer = setTimeout(() => this.setState({ error: null }), 15_000);
  }

  componentWillUnmount() {
    if (this.timer) clearTimeout(this.timer);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="panel widget-error">
          <b>{this.props.label ?? 'This view'} hit an error</b>
          <span className="muted small">{this.state.error.message}</span>
          <button onClick={() => this.setState({ error: null })}>Retry now</button>
          <span className="muted small">Retrying automatically…</span>
        </div>
      );
    }
    return this.props.children;
  }
}
