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

async function getContractVersion(contract: ethers.Contract): Promise<string> {
  let contractVersion = "1";
  try {
    contractVersion = await contract.version();
  } catch {
    // do nothing
  }
  return contractVersion;
}

async function main() {


  // Environment setup
  const privateKey = process.env.PRIVATE_KEY as Hex;
  const RPC_URL = process.env.RPC_URL;
  const assetTokenAddress = process.env.ASSETTOKEN;
  const paymentTokenAddress = process.env.PAYMENTTOKEN;
  const dinariApiKey = process.env.DINARI_API_KEY;
  const PIMLICO_API_KEY = process.env.PIMLICO_API_KEY;

  if (
    !privateKey ||
    !RPC_URL ||
    !assetTokenAddress ||
    !paymentTokenAddress ||
    !dinariApiKey ||
    !PIMLICO_API_KEY
  ) {
    throw new Error("Missing environment variables");
  }

  const dinariClient = axios.create({
    baseURL: "https://api-enterprise.sandbox.dinari.com",
    headers: {
      Authorization: `Bearer ${dinariApiKey}`,
      "Content-Type": "application/json",
    },
  });

  // Setup provider and signer
  // Setup provider and EOA signer
  const provider = ethers.getDefaultProvider(RPC_URL);
  const eoaSigner = new ethers.Wallet(privateKey, provider);
  console.log(`EOA Signer Address: ${eoaSigner.address}`);
  const chainId = Number((await provider.getNetwork()).chainId);

  // ------------------ Smart Account Setup ------------------

  const { publicClient, bundlerClient, paymasterClient, bundlerUrl } =
    await setupClients(RPC_URL, PIMLICO_API_KEY, privateKey);

  const { account, smartAccountClient } = await setupSmartAccount(
    publicClient,
    privateKey,
    bundlerUrl,
    bundlerClient,
    paymasterClient
  );

  const { paymentToken, assetToken, orderProcessor, orderProcessorAddress } =
    await setupContracts(
      provider,
      chainId,
      paymentTokenAddress,
      assetTokenAddress
    );

  // ------------------ Order Configuration ------------------

  const orderParams = await configureOrder(
    orderProcessor,
    assetToken,
    account.address, // smart account address
    assetTokenAddress,
    paymentTokenAddress
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
    args: [orderProcessorAddress, totalSpendAmount],
  }) as Hex;

  console.log("orderParams.recipient", orderParams.recipient);
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

  try {
    // 3. Create batch transaction data
    const transactions = [
      {
        to: paymentTokenAddress as Address,
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
  } catch (error) {
    console.error("Error:", error);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

async function configureOrder(
  orderProcessor: ethers.Contract,
  assetToken: ethers.Contract,
  recipientAddress: string,
  assetTokenAddress: string,
  paymentTokenAddress: string
) {
  // buy order amount (1 USDC)
  const orderAmount = BigInt(1_000_000);
  const sellOrder = false;
  const orderType = Number(0);
  const limitPrice = Number(0);

  // Check order precision for sell orders
  if (sellOrder) {
    await validateSellOrderPrecision(
      orderProcessor,
      assetToken,
      assetTokenAddress,
      orderAmount
    );
  }

  return {
    requestTimestamp: Date.now(),
    recipient: recipientAddress,
    assetToken: assetTokenAddress,
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
  assetTokenAddress: string,
  orderAmount: bigint
) {
  const allowedDecimalReduction = await orderProcessor.orderDecimalReduction(
    assetTokenAddress
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

async function setupClients(
  RPC_URL: string,
  PIMLICO_API_KEY: string,
  privateKey: Hex
) {
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
  paymentTokenAddress: string,
  assetTokenAddress: string
) {
  const orderProcessorAddress = orderProcessorData.networkAddresses[chainId];

  const paymentToken = new ethers.Contract(
    paymentTokenAddress,
    tokenAbi,
    provider
  );
  const assetToken = new ethers.Contract(assetTokenAddress, tokenAbi, provider);
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
