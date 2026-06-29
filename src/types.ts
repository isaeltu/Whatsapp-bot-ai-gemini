export type RestaurantInfo = {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  extraPrompt: string;
  businessHours: unknown;
  notificationEmail: string | null;
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
};

export type MenuSnapshot = {
  restaurant: RestaurantInfo;
  categories: Category[];
  products: Product[];
};

export type ConversationTurn = {
  role: "customer" | "bot";
  text: string;
  at: string;
};

export type CustomerProfile = {
  name: string;
  email: string;
};

export type DeliveryType = "" | "pickup" | "delivery";

export type ConversationState = {
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

export type LlmIntent = "chat" | "order" | "handoff";

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

export type UpsertCustomerResult = {
  customerId: string;
  fullName: string;
  email: string;
};
