import type { BalanceConfig } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { BalanceReservation, CheckBalanceDeps } from '~/middleware/checkBalance';
import type { ServerRequest } from '~/types/http';
import { checkBalance } from '~/middleware/checkBalance';
import { countTokens } from '~/utils/tokenizer';

export type RemoteAgentBalanceDeps = Omit<CheckBalanceDeps, 'balanceConfig'>;

export interface RemoteAgentBalanceParams {
  req: ServerRequest;
  res: Response;
  user: string;
  balanceConfig?: BalanceConfig | null;
  model?: string;
  endpoint?: string;
  endpointTokenConfig?: unknown;
  instructions?: string;
  messages: ReadonlyArray<{ role?: string; content?: unknown }>;
}

/** Collects the text a message sends: string content, or the `text` of each content part. */
function getMessageText(content: unknown): string[] {
  if (typeof content === 'string') {
    return [content];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((part) =>
    typeof part?.text === 'string' && part.text.length > 0 ? [part.text] : [],
  );
}

/**
 * Admits a remote (API key) agent request against the user's balance before the run starts,
 * as the chat UI does for every turn: the estimated prompt cost is reserved, a due auto-refill is
 * applied, and a user without enough credits is refused with a `token_balance` violation.
 * Resolves to `undefined` when balances are disabled; otherwise the caller releases the
 * reservation once the run's usage has been recorded.
 */
export async function reserveRemoteAgentBalance(
  params: RemoteAgentBalanceParams,
  deps: RemoteAgentBalanceDeps,
): Promise<BalanceReservation | undefined> {
  const { balanceConfig } = params;
  if (!balanceConfig?.enabled) {
    return undefined;
  }

  const promptText = [
    ...getMessageText(params.instructions),
    ...params.messages.flatMap((message) => getMessageText(message?.content)),
  ].join('\n');

  return checkBalance(
    {
      req: params.req,
      res: params.res,
      txData: {
        user: params.user,
        tokenType: 'prompt',
        amount: await countTokens(promptText),
        model: params.model,
        endpoint: params.endpoint,
        endpointTokenConfig: params.endpointTokenConfig,
      },
    },
    { ...deps, balanceConfig },
  );
}
