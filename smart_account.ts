import "dotenv/config";
import { ethers } from "ethers";
import {
  ENTRYPOINT_ADDRESS_V07,
  createSmartAccountClient,
} from "permissionless";
import {
  privateKeyToSimpleSmartAccount,
  signerToSafeSmartAccount,
  signerToSimpleSmartAccount,
} from "permissionless/accounts";
import {
  createPimlicoBundlerClient,
  createPimlicoPaymasterClient,
} from "permissionless/clients/pimlico";
import fs from "fs";
import path from "path";
import axios from "axios";
import {
  http,
  createPublicClient,
  Hex,
  Address,
  encodeFunctionData,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const orderProcessorDataPath = path.resolve(
  __dirname,
  "./order_processor.json"
);
const orderProcessorData = JSON.parse(
  fs.readFileSync(orderProcessorDataPath, "utf8")
);
const orderProcessorAbi = orderProcessorData.abi;

const tokenAbi = [
  "function name() external view returns (string memory)",
  "function decimals() external view returns (uint8)",
  "function version() external view returns (string memory)",
  "function nonces(address owner) external view returns (uint256)",
];

// NVIDIA 0x4B47153A241b9d22ae37c2aAEe7A6519fF2Dbfc6
// APPLE 0xD771a71E5bb303da787b4ba2ce559e39dc6eD85c
// AMZN 0x8D66331a76060e57E1d8Af220E535e354f13fE58

const STOCK_ADDRESSES = {
  APPLE: "0xD771a71E5bb303da787b4ba2ce559e39dc6eD85c",
  AMZN: "0x92d95BCB50B83d488bBFA18776ADC1553d3a8914",
  NVIDIA: "0x4B47153A241b9d22ae37c2aAEe7A6519fF2Dbfc6",
  TSLA: "0x7ec6109693fe6544DE4151c51FB4A41b279AdcE6",
  GOOGL: "0x56C4C5986C29d2289933B1D0baD13C01295c9Cd7",
} as const;

const ISAAC_MAIN_WALLET = "0x02C48c159FDfc1fC18BA0323D67061dE1dEA329F";
const RICARDO_ADDRESS = "0x71042ECc83238a3BF5a30f689F6505f895C5F424";
const ISAAC_ADDRESS = "0x862144d2BFd5d2865A8ac479F33f8B54d7ef3Bf5";

const STOCK_NAMES = {
  [STOCK_ADDRESSES.APPLE]: "apple",
  [STOCK_ADDRESSES.AMZN]: "amazon",
  [STOCK_ADDRESSES.NVIDIA]: "nvidia",
  [STOCK_ADDRESSES.TSLA]: "tesla",
  [STOCK_ADDRESSES.GOOGL]: "google",
} as const;

const ASSET_TOKEN_ADDRESS = STOCK_ADDRESSES.NVIDIA;
const SENT_STOCKS = true;

async function sendToken(
  smartAccountClient: any,
  asset: string = STOCK_ADDRESSES.APPLE,
  to: string = ISAAC_MAIN_WALLET
) {
  const tokenAmount = BigInt(0.1 * 10 ** 18);
  const approvalData = encodeFunctionData({
    abi: [
      {
        name: "approve",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [
          { name: "spender", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        outputs: [{ type: "bool" }],
      },
    ],
    functionName: "approve",
    args: [asset as Address, tokenAmount],
  }) as Hex;
  // Transfer asset token
  const transferData = encodeFunctionData({
    abi: [
      {
        name: "transfer",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [
          { name: "recipient", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        outputs: [{ type: "bool" }],
      },
    ],
    functionName: "transfer",
    args: [to as Address, tokenAmount],
  }) as Hex;

  const transactions_1 = [
    {
      to: asset as Address,
      data: approvalData,
      value: 0n,
    },
    {
      to: asset as Address,
      data: transferData,
      value: 0n,
    },
  ];

  const txHash = await smartAccountClient.sendTransactions({
    transactions: transactions_1,
  });
  console.log("sent token Hash:", txHash);
}

// Environment setup
const PRIVATE_KEY = process.env.PRIVATE_KEY as Hex;
const RPC_URL = process.env.RPC_URL;

const PAYMENT_TOKEN_ADDRESS = process.env.PAYMENTTOKEN;
const DINARI_API_KEY = process.env.DINARI_API_KEY;
const PIMLICO_API_KEY = process.env.PIMLICO_API_KEY;

async function main() {
  if (
    !PRIVATE_KEY ||
    !RPC_URL ||
    !PAYMENT_TOKEN_ADDRESS ||
    !DINARI_API_KEY ||
    !PIMLICO_API_KEY
  ) {
    throw new Error("Missing environment variables");
  }

  const dinariClient = axios.create({
    baseURL: "https://api-enterprise.sandbox.dinari.com",
    headers: {
      Authorization: `Bearer ${DINARI_API_KEY}`,
      "Content-Type": "application/json",
    },
  });

  // Setup provider and signer
  // Setup provider and EOA signer
  const provider = ethers.getDefaultProvider(RPC_URL);
  const eoaSigner = new ethers.Wallet(PRIVATE_KEY, provider);
  console.log(`EOA Signer Address: ${eoaSigner.address}`);
  const chainId = Number((await provider.getNetwork()).chainId);

  // ------------------ Smart Account Setup ------------------

  const { publicClient, bundlerClient, paymasterClient, bundlerUrl } =
    await setupClients(RPC_URL, PIMLICO_API_KEY);

  const { account, smartAccountClient } = await setupSmartAccount(
    publicClient,
    PRIVATE_KEY,
    bundlerUrl,
    bundlerClient,
    paymasterClient
  );

  const { paymentToken, assetToken, orderProcessor, orderProcessorAddress } =
    await setupContracts(provider, chainId, PAYMENT_TOKEN_ADDRESS);

  // ------------------ Order Configuration ------------------

  const stock = STOCK_NAMES[ASSET_TOKEN_ADDRESS];
  console.log("stock", stock, ASSET_TOKEN_ADDRESS);

  const orderParams = await configureOrder(
    orderProcessor,
    assetToken,
    account.address, // smart account address
    PAYMENT_TOKEN_ADDRESS
  );
  console.log("orderParams", orderParams);

  // // Get fee quote
  const { fees, feeQuoteResponse } = await getFeeQuote(
    dinariClient,
    chainId,
    orderProcessorAddress,
    orderParams
  );
  //console.log("feeQuoteResponse", feeQuoteResponse);

  const totalSpendAmount = BigInt(orderParams.paymentTokenQuantity) + fees;
  console.log(`fees: ${ethers.utils.formatUnits(fees, 6)}`);
  console.log(
    `totalSpendAmount: ${ethers.utils.formatUnits(totalSpendAmount, 6)}`
  );

  // ------------------ Create Batch Transaction ------------------

  console.log("orderParams.recipient", orderParams.recipient);

  try {
    if (SENT_STOCKS) {
      await sendToken(smartAccountClient);
    } else {
      await createOrder(
        orderProcessor,
        smartAccountClient,
        bundlerClient,
        publicClient,
        orderParams,
        feeQuoteResponse,
        totalSpendAmount,
        orderProcessorAddress
      );
    }
  } catch (error) {
    console.error("Error:", error);
  }
}

async function createOrder(
  orderProcessor: ethers.Contract,
  smartAccountClient: any,
  bundlerClient: any,
  publicClient: any,
  orderParams: OrderParams,
  feeQuoteResponse: any,
  totalSpendAmount: bigint,
  orderProcessorAddress: string
) {
  // 1. Encode approval data
  const approvalData = encodeFunctionData({
    abi: [
      {
        name: "approve",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [
          { name: "spender", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        outputs: [{ type: "bool" }],
      },
    ],
    functionName: "approve",
    args: [orderProcessorAddress as Address, totalSpendAmount],
  }) as Hex;
  // 2. Encode order creation call
  const createOrderData = encodeFunctionData({
    abi: orderProcessorAbi,
    functionName: "createOrder",
    args: [
      [
        orderParams.requestTimestamp, // When the order was created
        orderParams.recipient, // Who receives the assets
        orderParams.assetToken, // Token you want to buy/sell
        orderParams.paymentToken, // Token you're paying with
        orderParams.sell, // false = buy, true = sell
        orderParams.orderType, // 0 = market order
        orderParams.assetTokenQuantity, // Amount of asset tokens
        orderParams.paymentTokenQuantity, // Amount of payment tokens
        orderParams.price, // Limit price (0 for market orders)
        orderParams.tif, // Time in force (1 = good til cancelled)
      ],
      [
        feeQuoteResponse.fee_quote.orderId, // Unique ID for this fee quote
        feeQuoteResponse.fee_quote.requester, // Who requested the quote
        feeQuoteResponse.fee_quote.fee, // Fee amount
        feeQuoteResponse.fee_quote.timestamp, // When quote was issued
        feeQuoteResponse.fee_quote.deadline, // When quote expires
      ],
      feeQuoteResponse.fee_quote_signature,
    ],
  }) as Hex;
  // 3. Create batch transaction data
  const transactions = [
    {
      to: PAYMENT_TOKEN_ADDRESS as Address,
      data: approvalData as Hex,
      value: 0n,
    },
    {
      to: orderProcessorAddress as Address,
      data: createOrderData as Hex,
      value: 0n,
    },
  ];

  await executeOrderTransaction(
    smartAccountClient,
    bundlerClient,
    publicClient,
    transactions,
    orderProcessor
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

interface OrderParams {
  requestTimestamp: number;
  recipient: string;
  assetToken: string;
  paymentToken: string;
  sell: boolean;
  orderType: number;
  assetTokenQuantity: number;
  paymentTokenQuantity: number;
  price: number;
  tif: number;
}
async function configureOrder(
  orderProcessor: ethers.Contract,
  assetToken: ethers.Contract,
  recipientAddress: string,
  paymentTokenAddress: string,
  amount: number = 100 * 10 ** 6
): Promise<OrderParams> {
  // buy order amount (1 USDC)
  const orderAmount = BigInt(amount);
  const sellOrder = false;
  const orderType = Number(0);
  const limitPrice = Number(0);

  // Check order precision for sell orders
  if (sellOrder) {
    await validateSellOrderPrecision(orderProcessor, assetToken, orderAmount);
  }

  return {
    requestTimestamp: Date.now(),
    recipient: recipientAddress,
    assetToken: ASSET_TOKEN_ADDRESS,
    paymentToken: paymentTokenAddress,
    sell: sellOrder,
    orderType: orderType,
    assetTokenQuantity: 0,
    paymentTokenQuantity: Number(orderAmount),
    price: limitPrice,
    tif: 1,
  };
}

async function validateSellOrderPrecision(
  orderProcessor: ethers.Contract,
  assetToken: ethers.Contract,
  orderAmount: bigint
) {
  const allowedDecimalReduction = await orderProcessor.orderDecimalReduction(
    ASSET_TOKEN_ADDRESS
  );
  const allowablePrecisionReduction = 10 ** allowedDecimalReduction;

  if (Number(orderAmount) % allowablePrecisionReduction != 0) {
    const assetTokenDecimals = await assetToken.decimals();
    const maxDecimals = assetTokenDecimals - allowedDecimalReduction;
    throw new Error(
      `Order amount precision exceeds max decimals of ${maxDecimals}`
    );
  }
}

async function getFeeQuote(
  dinariClient: any,
  chainId: number,
  orderProcessorAddress: string,
  orderParams: any
) {
  const feeQuoteData = {
    chain_id: chainId,
    contract_address: orderProcessorAddress,
    order_data: orderParams,
  };
  const feeQuoteResponse = await dinariClient.post(
    "/api/v1/web3/orders/fee",
    feeQuoteData
  );
  return {
    fees: BigInt(feeQuoteResponse.data.fee_quote.fee),
    feeQuoteResponse: feeQuoteResponse.data,
  };
}

async function setupClients(RPC_URL: string, PIMLICO_API_KEY: string) {
  const bundlerUrl = `https://api.pimlico.io/v2/sepolia/rpc?apikey=${PIMLICO_API_KEY}`;

  const publicClient = createPublicClient({
    transport: http(RPC_URL),
  });

  const bundlerClient = createPimlicoBundlerClient({
    transport: http(bundlerUrl),
    entryPoint: ENTRYPOINT_ADDRESS_V07,
  });

  const paymasterClient = createPimlicoPaymasterClient({
    transport: http(bundlerUrl),
    entryPoint: ENTRYPOINT_ADDRESS_V07,
  });

  return { publicClient, bundlerClient, paymasterClient, bundlerUrl };
}

async function setupSmartAccount(
  publicClient: any,
  privateKey: Hex,
  bundlerUrl: string,
  bundlerClient: any,
  paymasterClient: any
) {
  const account = await signerToSimpleSmartAccount(publicClient, {
    signer: privateKeyToAccount(privateKey),
    factoryAddress: "0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985",
    entryPoint: ENTRYPOINT_ADDRESS_V07,
  });

  const smartAccountClient = createSmartAccountClient({
    account,
    entryPoint: ENTRYPOINT_ADDRESS_V07,
    chain: sepolia,
    bundlerTransport: http(bundlerUrl),
    middleware: {
      gasPrice: async () => {
        return (await bundlerClient.getUserOperationGasPrice()).fast;
      },
      sponsorUserOperation: paymasterClient.sponsorUserOperation,
    },
  });

  return { account, smartAccountClient };
}

async function setupContracts(
  provider: ethers.providers.Provider,
  chainId: number,
  paymentTokenAddress: string
) {
  const orderProcessorAddress = orderProcessorData.networkAddresses[chainId];

  const paymentToken = new ethers.Contract(
    paymentTokenAddress,
    tokenAbi,
    provider
  );
  const assetToken = new ethers.Contract(
    ASSET_TOKEN_ADDRESS,
    tokenAbi,
    provider
  );
  const orderProcessor = new ethers.Contract(
    orderProcessorAddress,
    orderProcessorAbi,
    provider
  );

  return { paymentToken, assetToken, orderProcessor, orderProcessorAddress };
}

async function executeOrderTransaction(
  smartAccountClient: any,
  bundlerClient: any,
  publicClient: any,
  transactions: any[],
  orderProcessor: ethers.Contract
) {
  const hash = await smartAccountClient.sendTransactions({
    transactions,
  });

  console.log("UserOperation Hash:", hash);

  // Wait for transaction
  const receipt = await bundlerClient.waitForUserOperationReceipt({
    hash,
    timeout: 60000,
  });

  // Get the actual transaction receipt using the transactionHash from the UserOp receipt
  const txReceipt = await publicClient.getTransactionReceipt({
    hash: receipt.receipt.transactionHash as `0x${string}`,
  });

  console.log("Transaction Receipt:", txReceipt);

  // Parse the OrderCreated event
  const orderCreatedEvent = txReceipt.logs.find(
    (log: any) =>
      log.address.toLowerCase() === orderProcessor.address.toLowerCase() &&
      log.topics[0] === orderProcessor.interface.getEventTopic("OrderCreated")
  );

  if (orderCreatedEvent) {
    const decodedLog = orderProcessor.interface.parseLog(orderCreatedEvent);
    const orderId = decodedLog.args[0];
    const orderAccount = decodedLog.args[1];
    console.log(`Order ID: ${orderId}`);
    console.log(`Order Account: ${orderAccount}`);

    const orderStatus = await orderProcessor.getOrderStatus(orderId);
    console.log(`Order Status: ${orderStatus}`);
  } else {
    console.log("No OrderCreated event found in logs");
    console.log("All transaction logs:", txReceipt.logs);
  }
}
