"""Response models for the ``/embed`` contract (camelCase, per the spec)."""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel


class ConfigResponse(BaseModel):
    frameOrigin: str
    apiBase: str


class Session(BaseModel):
    sessionToken: str
    organizationId: str
    expiresAt: str


class CatalogType(BaseModel):
    typeId: str
    name: str


class ConfiguredConnector(BaseModel):
    id: str
    typeId: str
    name: str


class BuiltPipeline(BaseModel):
    pipelineId: str
    outputId: str
    status: str
    active: bool


class PipelineStatus(BaseModel):
    hasPipeline: bool
    enabled: bool
    pipelineId: Optional[str] = None
    inputId: Optional[str] = None
    outputId: Optional[str] = None
