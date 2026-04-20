import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props { children: ReactNode; }
interface State { error: Error | null; }

export class ErrorBoundary extends Component<Props, State> {
    state: State = { error: null };

    static getDerivedStateFromError(error: Error): State {
        return { error };
    }

    componentDidCatch(error: Error, info: ErrorInfo): void {
        console.error('[ErrorBoundary]', error, info.componentStack);
    }

    private handleReload = () => {
        window.location.reload();
    };

    private handleReset = () => {
        this.setState({ error: null });
    };

    render(): ReactNode {
        const { error } = this.state;
        if (!error) return this.props.children;
        return (
            <div className="error-boundary">
                <div className="error-boundary-card">
                    <div className="error-boundary-icon">⚠</div>
                    <h2 className="error-boundary-title">应用出错了</h2>
                    <p className="error-boundary-message">{error.message || String(error)}</p>
                    {error.stack && (
                        <details className="error-boundary-details">
                            <summary>调用栈</summary>
                            <pre className="error-boundary-stack">{error.stack}</pre>
                        </details>
                    )}
                    <div className="error-boundary-actions">
                        <button className="connect-btn" onClick={this.handleReload}>刷新页面</button>
                        <button className="forget-btn" onClick={this.handleReset}>尝试恢复</button>
                    </div>
                </div>
            </div>
        );
    }
}
