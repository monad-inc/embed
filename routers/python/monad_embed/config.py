"""Configuration for the ``/embed`` router — uniform across every language."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Awaitable, Callable, Optional, Union

from starlette.requests import Request


@dataclass
class Provision:
    """What the host pre-provisions per tenant, resolved server-side.

    Never sent by the browser.
    """

    #: Ingress target. ``None`` → ingress goes to a dev/null sink.
    destination_output_id: Optional[str] = None
    #: Egress source. ``None`` → egress is unavailable.
    source_input_id: Optional[str] = None


#: Resolve the authenticated request to the caller's Monad team id. Sync or async.
GetCustomerOrgID = Callable[[Request], Union[str, Awaitable[str]]]
#: Return a tenant's pre-provisioned resources. Sync or async.
GetProvisionedComponents = Callable[[str], Union[Provision, Awaitable[Provision]]]


@dataclass
class EmbedConfig:
    """Uniform router configuration."""

    #: Long-lived Monad API key. Server-side only.
    api_key: str
    #: Map the authenticated request → the caller's Monad team id. The one seam
    #: only the host can fill. Raise (or return ``""``) to reject → 401.
    get_customer_org_id: GetCustomerOrgID
    #: Monad API base. Defaults to ``https://app.monad.com/api`` (production);
    #: set only for non-prod.
    api_base: str = "https://app.monad.com/api"
    #: Iframe origin returned by ``GET /embed/config``. Defaults to
    #: ``https://app.monad.com/embed`` (production); set only for non-prod.
    frame_origin: str = "https://app.monad.com/embed"
    #: Per-tenant pre-provisioned resources. ``None`` → ingress uses dev/null and
    #: egress is unavailable.
    get_provisioned_components: Optional[GetProvisionedComponents] = None
    #: Restrict the catalog to these connector type ids. ``None`` → all.
    catalog_allow: Optional[list[str]] = None
