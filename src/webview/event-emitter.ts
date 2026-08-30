type Listener = (...args: unknown[]) => void;

export class EventEmitter {
  private readonly listeners = new Map<string | symbol, Listener[]>();

  public on(event: string | symbol, listener: Listener): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  public addListener(event: string | symbol, listener: Listener): this {
    return this.on(event, listener);
  }

  public once(event: string | symbol, listener: Listener): this {
    const wrapper: Listener = (...args) => {
      this.removeListener(event, wrapper);
      listener(...args);
    };
    return this.on(event, wrapper);
  }

  public emit(event: string | symbol, ...args: unknown[]): boolean {
    const listeners = this.listeners.get(event);
    if (listeners === undefined) {
      return false;
    }
    for (const listener of [...listeners]) {
      listener(...args);
    }
    return true;
  }

  public removeListener(event: string | symbol, listener: Listener): this {
    const listeners = this.listeners.get(event);
    if (listeners === undefined) {
      return this;
    }
    const next = listeners.filter((candidate) => candidate !== listener);
    if (next.length === 0) {
      this.listeners.delete(event);
    } else {
      this.listeners.set(event, next);
    }
    return this;
  }

  public off(event: string | symbol, listener: Listener): this {
    return this.removeListener(event, listener);
  }

  public removeAllListeners(event?: string | symbol): this {
    if (event === undefined) {
      this.listeners.clear();
    } else {
      this.listeners.delete(event);
    }
    return this;
  }

  public listenerCount(event: string | symbol): number {
    return this.listeners.get(event)?.length ?? 0;
  }
}

export default EventEmitter;
