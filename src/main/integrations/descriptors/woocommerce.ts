import type { IntegrationDescriptorDef } from '../../../shared/integrations'

/**
 * WooCommerce connector config surface (spec §4.3, §7). The store URL is a
 * non-secret ref → config.json; the consumer key/secret and webhook signing
 * secret are SECRETS → the CredentialStore keychain (spec §5). Field/trigger/
 * action ids are the contract the flow engine/canvas depend on and are aligned
 * with the Shopify sibling so one flow template can target either platform — a
 * snapshot test guards them.
 */
export const woocommerceDescriptor: IntegrationDescriptorDef = {
  id: 'woocommerce',
  label: 'WooCommerce',
  configFields: [
    {
      key: 'storeUrl',
      label: 'Store URL (https://…)',
      secret: false,
      required: true,
      type: 'string',
      placeholder: 'https://shop.example.com'
    },
    {
      key: 'consumerKey',
      label: 'Consumer key (ck_…)',
      secret: true,
      required: true,
      type: 'string'
    },
    {
      key: 'consumerSecret',
      label: 'Consumer secret (cs_…)',
      secret: true,
      required: true,
      type: 'string'
    },
    {
      key: 'webhookSecret',
      label: 'Webhook signing secret',
      secret: true,
      required: true,
      type: 'string'
    },
    {
      key: 'environment',
      label: 'saiife environment (1-9)',
      secret: false,
      required: true,
      type: 'number'
    }
  ],
  triggers: [
    { id: 'order.created', label: 'New order placed' },
    // Derived in-flow — WC has no native refund-request webhook (spec §6.1); the
    // id is kept for Shopify template parity, its ingress diverges.
    { id: 'order.refundRequested', label: 'Customer requested a refund' }
  ],
  actions: [
    { id: 'getOrder', label: 'Get an order' },
    { id: 'getCustomer', label: 'Get a customer' },
    { id: 'searchOrders', label: 'Search orders' },
    // Gated mutations — run ONLY because a flow action node reached them (§4.6).
    { id: 'refundOrder', label: 'Refund an order' },
    { id: 'cancelOrder', label: 'Cancel an order' },
    { id: 'updateShippingAddress', label: 'Update shipping address' },
    { id: 'addOrderNote', label: 'Add an order note' }
  ]
}
