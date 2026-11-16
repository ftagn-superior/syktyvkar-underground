export type ChatReturnMode = 'overview' | 'first-person-cursor' | 'first-person-active';

type ControlIntent = { readonly revision: number; readonly session: object };
export type ChatReturn = ControlIntent & { readonly mode: ChatReturnMode };

/** A temporary chat interaction cannot undo a newer control or UI decision. */
export class ChatReturnContext {
  private revision = 0;
  private chat?: ChatReturn;
  private command?: { requestId: number; session: object };

  invalidate(): void {
    this.pauseControls();
    this.command = undefined;
  }

  /** Network waiting stops control restoration without cancelling a pending UI reply. */
  pauseControls(): void {
    this.revision++;
    this.chat = undefined;
  }

  begin(mode: ChatReturnMode, session: object): void {
    this.invalidate();
    this.chat = { mode, session, revision: this.revision };
  }

  finish(session: object | undefined): ChatReturn | undefined {
    const previous = this.chat;
    this.chat = undefined;
    return previous && this.isCurrent(previous, session) ? previous : undefined;
  }

  isCurrent(intent: ControlIntent, session: object | undefined): boolean {
    return intent.revision === this.revision && intent.session === session;
  }

  sent(requestId: number, session: object): void {
    this.command = { requestId, session };
  }

  /** Consume only the matching result; an old reply cannot cancel a newer command. */
  acceptCommand(requestId: number, session: object | undefined): boolean {
    const command = this.command;
    if (!command || command.requestId !== requestId) return false;
    this.command = undefined;
    return command.session === session;
  }
}
