# Skill: Gestión y Despliegue de Esquemas de BD (`db_migration`)

| Metadata | Valor |
| :--- | :--- |
| **Identificador** | `skl_db_migration` |
| **Tipo** | Funcionalidad Atómica Ejecutable (Nivel 2) |
| **Herramientas Asociadas** | Prisma CLI (`npx prisma`), PostgreSQL |
| **Estándar** | SKL-PRO-001 |

---

## 1. Propósito y Cuándo Usar

Instruir al agente sobre cómo sincronizar de forma segura y controlada las definiciones del archivo `prisma/schema.prisma` con el motor de base de datos PostgreSQL.

> [!CAUTION]
> **RESTRICCIÓN DE GOBERNANZA (Regla ASK):**
> El agente de IA **tiene prohibido ejecutar comandos de migración sin confirmación humana previa explícita**. Toda alteración de esquemas requiere aprobación del Líder Técnico.

---

## 2. Comandos Operativos

```bash
# 1. Validar la sintaxis del esquema de Prisma (Modo Seguro - Solo lectura)
npx prisma validate

# 2. Generar el cliente fuertemente tipado de Prisma Client
npx prisma generate

# 3. Empujar cambios de esquema en desarrollo rápido (Requiere autorización humana)
npx prisma db push

# 4. Crear migración declarativa para entornos productivos (Requiere autorización humana)
npx prisma migrate dev --name <nombre_descriptivo_de_la_migracion>

# 5. Aplicar migraciones en entornos de CI/CD o producción
npx prisma migrate deploy
```

---

## 3. Protocolo de Verificación de Integridad

1. Antes de aplicar cambios en la base de datos, revisar si la modificación elimina columnas o altera restricciones de llaves foráneas (`ON DELETE CASCADE`, `ON DELETE RESTRICT`).
2. Actualizar en paralelo `doc/architecture/diccionario_de_datos.md` y `llm.txt` para mantener la sincronización y evitar *Context Rot*.
