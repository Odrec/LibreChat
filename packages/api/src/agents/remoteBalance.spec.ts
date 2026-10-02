import mongoose from 'mongoose';
import { ViolationTypes } from 'librechat-data-provider';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMethods, createModels } from '@librechat/data-schemas';
import type { IBalance } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { RemoteAgentBalanceDeps } from './remoteBalance';
import type { ServerRequest } from '~/types/http';
import { reserveRemoteAgentBalance } from './remoteBalance';
import { countTokens } from '~/utils/tokenizer';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: {
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

describe('reserveRemoteAgentBalance', () => {
  let mongoServer: MongoMemoryServer;
  let Balance: mongoose.Model<IBalance>;
  let methods: ReturnType<typeof createMethods>;

  const req = { user: { id: 'user-1' } } as ServerRequest;
  const res = {} as Response;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    createModels(mongoose);
    Balance = mongoose.models.Balance as mongoose.Model<IBalance>;
    methods = createMethods(mongoose);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await mongoose.connection.dropDatabase();
  });

  const realDeps = (): RemoteAgentBalanceDeps => ({
    getMultiplier: () => 1,
    reserveBalance: jest.fn(methods.reserveBalance),
    renewBalanceReservation: methods.renewBalanceReservation,
    releaseBalanceReservation: methods.releaseBalanceReservation,
    logViolation: jest.fn().mockResolvedValue(undefined),
  });

  const reserve = (user: string, deps: RemoteAgentBalanceDeps, enabled = true) =>
    reserveRemoteAgentBalance(
      {
        req,
        res,
        user,
        balanceConfig: { enabled },
        model: 'gpt-4o',
        endpoint: 'openAI',
        instructions: 'You are a helpful assistant.',
        messages: [
          { role: 'user', content: 'Summarize the attached report.' },
          { role: 'assistant', content: [{ type: 'text', text: 'Which report?' }] },
          { role: 'user', content: [{ type: 'input_text', text: 'The quarterly one.' }] },
        ],
      },
      deps,
    );

  const storedOf = (user: string) => Balance.findOne({ user }).select('+reservedCredits').lean();

  it('refuses a request from a user whose credits are spent', async () => {
    const user = new mongoose.Types.ObjectId().toString();
    await Balance.create({ user, tokenCredits: 0 });
    const deps = realDeps();

    await expect(reserve(user, deps)).rejects.toThrow(ViolationTypes.TOKEN_BALANCE);
    expect(deps.logViolation).toHaveBeenCalledTimes(1);
  });

  it('holds the estimated prompt cost until the reservation is released', async () => {
    const user = new mongoose.Types.ObjectId().toString();
    await Balance.create({ user, tokenCredits: 10_000 });
    const expected = await countTokens(
      [
        'You are a helpful assistant.',
        'Summarize the attached report.',
        'Which report?',
        'The quarterly one.',
      ].join('\n'),
    );

    const reservation = await reserve(user, realDeps());

    expect((await storedOf(user))?.reservedCredits).toBe(expected);
    await reservation?.release();
    expect((await storedOf(user))?.reservedCredits).toBe(0);
  });

  it('applies a due auto-refill before admitting the request', async () => {
    const user = new mongoose.Types.ObjectId().toString();
    await Balance.create({
      user,
      tokenCredits: 0,
      autoRefillEnabled: true,
      refillAmount: 5000,
      refillIntervalValue: 7,
      refillIntervalUnit: 'days',
      lastRefill: new Date('2020-01-01T00:00:00.000Z'),
    });

    const reservation = await reserve(user, realDeps());

    expect((await storedOf(user))?.tokenCredits).toBe(5000);
    await reservation?.release();
  });

  it('admits without reserving when balances are disabled', async () => {
    const user = new mongoose.Types.ObjectId().toString();
    await Balance.create({ user, tokenCredits: 0 });
    const deps = realDeps();

    await expect(reserve(user, deps, false)).resolves.toBeUndefined();
    expect(deps.reserveBalance).not.toHaveBeenCalled();
  });
});
