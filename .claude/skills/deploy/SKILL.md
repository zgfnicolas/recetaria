---
name: deploy
description: Habilidad para verificar, compilar y preparar el despliegue del backend de Recetaria API
command: /deploy
---

# Skill: Despliegue de la Aplicación (`deploy`)

## 1. Propósito y Activación
Esta habilidad se activa cuando el desarrollador invoca `/deploy` o solicita preparar el despliegue del backend para entornos de desarrollo, staging o producción (Docker, Render, Railway).

## 2. Checklist Previo al Despliegue (DoD)
Antes de proceder con cualquier despliegue, el agente debe verificar que:
1. El código TypeScript compila sin errores: `npm run build`.
2. Las pruebas automatizadas pasan al 100%: `npm test`.
3. El esquema de Prisma es válido y no tiene conflictos: `npx prisma validate`.
4. El archivo `.env.example` contiene todas las variables de entorno requeridas sin valores reales.

## 3. Comandos de Despliegue

```bash
# Paso 1: Validar esquema de base de datos
npx prisma validate

# Paso 2: Generar Prisma Client
npx prisma generate

# Paso 3: Compilar TypeScript
npm run build

# Paso 4: Aplicar migraciones en la base de datos de destino
npx prisma migrate deploy

# Paso 5: Iniciar el servidor compilado
node dist/index.js
```

Para detalles de entornos de despliegue específicos, consulta `deploy-config.md`.
