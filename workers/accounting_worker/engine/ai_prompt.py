"""The global AI classification prompt, built where it can be inspected.

Every workspace's ambiguous rows are sent to the model with the SAME prompt, so
anything written into it is disclosed on behalf of every tenant. The prompt used
to carry a supplier list grown from one customer's statements — Afrigreen,
Acapolite, RMSP Trading, Stalitrex, NMS Enterprises, JC Industries, Fabric And
Leather, Allianz Holdings, Senses Spa, Sloppy Kisses, Puppy Classes, Prayer
Shop, the bulk-credit reference 047-GP HEA, Stratum, Disc Prem — and one line
went as far as naming that customer's own account holder to tell the model how
to read a reference containing it.

Two things were wrong with that, and only one of them is a privacy problem:

  1. Classifying workspace B's transactions transmitted workspace A's trading
     relationships to OpenAI. Neither workspace asked for that.
  2. It steered every workspace with a stranger's ledger. A model told that
     "Afrigreen or customer-name EFT credits" means revenue has been given a
     fact about someone else's business and no rule it can generalise from.

Building the prompt here rather than inline in the request function is what
makes the first testable: a test can assert what the prompt contains without an
API key and without a network call. engine/ai_prompt_knowledge.json holds the
merchant knowledge that is allowed to appear, and the rule for what qualifies.

The classification VALUE of the removed entries is kept. Every customer name
stood for a general pattern — an inbound credit against a trading reference, an
outbound payment to a registered-looking company, a personal-looking merchant
that should stay in review — and those patterns are stated directly in
merchant_patterns, which is what the model could actually have generalised from
in the first place.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

_KNOWLEDGE_FILE = Path(__file__).with_name("ai_prompt_knowledge.json")


@lru_cache(maxsize=1)
def prompt_knowledge() -> dict[str, Any]:
    return json.loads(_KNOWLEDGE_FILE.read_text())


INSTRUCTIONS = (
    "Classify South African business bank statement transactions for accounting review. "
    "Return strict JSON only. Do not infer amounts, balances, dates, or reconciliation. "
    "Use conservative VAT treatment. Mark ambiguous, personal-looking, entertainment, or supplier-unknown items for review. "
    "Do not classify purely because a generic keyword appears in the description. "
    "Use merchant semantics, recurring pattern, amount direction, and the existing rule result. "
    "The account holder / company name printed on the statement is context, not a merchant. "
    "Never classify a row into a category merely because the account holder's own name appears in the description. "
    "Where you can identify the merchant behind the bank's wording, return it as normalized_merchant using only words that "
    "appear in the description. If you cannot tell, return null - a null merchant is correct and an invented one is not."
)

CLASSIFICATION_POLICY = [
    "Money In from a customer, tender, government department, province or municipality must normally be Sales / Revenue with Output VAT review/standard treatment.",
    "Money Out to a registered-looking company name, supplier name, or description containing Industries, Trading, Enterprises, Services, Invoice, or Inv must normally be Supplier Payments or Operating Expenses with invoice support required, not Staff Welfare.",
    "Large outbound payments above 5,000 require stronger business-context review. Never classify a large invoice/company payment as meals, entertainment, travel, or staff welfare unless the merchant itself is clearly food, restaurant, catering, personal care, or entertainment.",
    "Use Staff Welfare / Meals / Entertainment only for food, groceries, restaurant, personal care, entertainment, or welfare merchants.",
    "If the description contains the account holder name, ignore that account-holder wording and classify by the counterparty/merchant semantics.",
    "If a supplier is business-like but the exact expense nature is unclear, choose Supplier Payments, VAT review, invoice_required true, review_required true, and explain what invoice/support is needed.",
    # Direction is a constraint, not a category: a credit is not automatically
    # revenue and a debit is not automatically an expense. Refunds, reversals
    # and inter-account movements are the cases that break the shortcut.
    "Direction constrains but never decides the category. A credit may be a refund, a reversal, a loan drawdown or a transfer between the holder's own accounts, and a debit may be a loan repayment or a transfer out. Check what the counterparty is before letting direction choose.",
]

RESPONSE_SCHEMA = {
    "items": [
        {
            "transaction_id": "string",
            "account": "string",
            "group": "string",
            "vat_treatment": "string",
            "vat_claim_status": "string",
            "review_required": True,
            "review_reason": "string",
            "invoice_required": True,
            "confidence": 0.72,
            "normalized_merchant": "string or null - the merchant behind the bank wording, using ONLY words present in the description; null if you cannot tell",
            "reason": "string",
            "explanation": "string",
        }
    ]
}


def build_classification_prompt(items: list[dict[str, Any]]) -> dict[str, Any]:
    """The prompt sent for a batch of rows.

    `items` is the only tenant-specific part, and it is the part that has to be:
    those are the rows being classified. Everything above it is global, and so
    everything above it has to be knowledge a stranger could have written.
    """
    knowledge = prompt_knowledge()
    return {
        "instructions": INSTRUCTIONS,
        "merchant_knowledge_scope": (
            "The merchant guidance below is public brand knowledge and general patterns only. "
            "It deliberately names no specific customer, supplier or payee. Do not assume a counterparty "
            "you have not been shown, and do not invent one."
        ),
        "public_merchant_knowledge": knowledge["public_merchants"],
        "merchant_patterns": knowledge["merchant_patterns"],
        "classification_policy": CLASSIFICATION_POLICY,
        "schema": RESPONSE_SCHEMA,
        "transactions": items,
    }


def global_prompt_text(items: list[dict[str, Any]] | None = None) -> str:
    """The serialised global prompt, with no transactions in it by default.

    Used by the regression test: what a leak check has to read is exactly what
    would be sent, not a reconstruction of it.
    """
    return json.dumps(build_classification_prompt(items or []), default=str)
