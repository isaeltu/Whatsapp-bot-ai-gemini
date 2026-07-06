export type RestaurantInfo = {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  extraPrompt: string;
  businessHours: unknown;
  notificationEmail: string | null;
  paymentEnabled: boolean;
};

export type Category = {
  id: string;
  name: string;
  description: string | null;
};

export type Product = {
  id: string;
  categoryId: string;
  name: string;
  description: string | null;
  price: number;
  tags?: string[];
};

// Configuracion estructurada del bot definida por el admin del restaurante
// (restaurant_bot_settings). Todo opcional porque el RPC viejo (antes de la
// migracion 202607060001_bot_intelligence) no devuelve estos campos.
export type BotConfig = {
  tone?: string;                    // amigable | formal | experto | casual | vendedor | familiar
  recommendationLevel?: string;     // basico | vendedor | experto
  welcomeMessage?: string;
  fallbackMessage?: string;
  customRules?: string;
  signaturePhrases?: string;
  avoidTopics?: string;
  unavailableProductRule?: string;
  allowDrinkSuggestions?: boolean;
  allowComboSuggestions?: boolean;
  allowHistorySuggestions?: boolean;
};

export type MenuSnapshot = {
  restaurant: RestaurantInfo;
  categories: Category[];
  products: Product[];
  botConfig?: BotConfig | null;
  unavailableProducts?: string[];   // existen pero hoy no estan disponibles
  popularProductIds?: string[];     // top ventas reales de los ultimos 60 dias
  approvedInsights?: string[];      // sugerencias aprendidas YA aprobadas por el admin
};

export type ConversationTurn = {
  role: "customer" | "bot";
  text: string;
  at: string;
};

export type CustomerFlowStage =
  | "CHECK_CUSTOMER"
  | "ASK_CUSTOMER_NAME"
  | "ASK_CUSTOMER_EMAIL"
  | "CUSTOMER_IDENTIFIED"
  | "ORDER_PRODUCTS"
  | "PAYMENT_METHOD"
  | "CONFIRM_ORDER";

export type CustomerProfile = {
  customerId: string;
  phone: string;
  name: string;
  email: string;
};

export type DeliveryType = "" | "pickup" | "delivery";

export type ConversationState = {
  stage: CustomerFlowStage;
  history: ConversationTurn[];
  failedAttempts: number;
  profile: CustomerProfile;
  deliveryType: DeliveryType;
  deliveryAddress: string;
};

export type OrderItem = {
  productId: string;
  quantity: number;
  notes?: string;
};

export type LlmIntent = "chat" | "order" | "card_payment" | "handoff";

export type LlmResult = {
  intent: LlmIntent;
  replyText: string;
  items: OrderItem[];
  reason: string;
  customerName: string;
  customerEmail: string;
  transcript: string;
  deliveryType: string;
  deliveryAddress: string;
};

export type IncomingMessage =
  | { kind: "text"; text: string }
  | { kind: "audio"; mimeType: string; data: string };

export type CreateOrderResult = {
  orderId: string;
  orderNumber: string;
  total: number;
  notificationEmail: string | null;
};

export type CreatePaymentLinkResult = {
  linkId: string;
  total: number;
};

export type CustomerLookupResult = {
  customerId: string;
  fullName: string;
  email: string;
  phone: string;
  missingName: boolean;
  missingEmail: boolean;
};

export type UpsertCustomerResult = CustomerLookupResult;
