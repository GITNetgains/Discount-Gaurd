use crate::schema;
use shopify_function::prelude::*;
use shopify_function::Result;

#[derive(Deserialize, Default, PartialEq)]
#[shopify_function(rename_all = "camelCase")]
pub struct Configuration {
    percentage: f64,
    message: String,
}

#[shopify_function]
pub fn cart_lines_discounts_generate_run(
    input: schema::cart_lines_discounts_generate_run::Input,
) -> Result<schema::CartLinesDiscountsGenerateRunResult> {
    let config: &Configuration = match input.discount().metafield() {
        Some(metafield) => metafield.json_value(),
        None => {
            return Ok(schema::CartLinesDiscountsGenerateRunResult {
                operations: vec![],
            })
        }
    };

    if config.percentage <= 0.0 {
        return Ok(schema::CartLinesDiscountsGenerateRunResult {
            operations: vec![],
        });
    }

    let mut candidates = vec![];

    for line in input.cart().lines().iter() {
        let current_price = line.cost().amount_per_quantity().amount().as_f64();

        let is_sale_line = line
            .cost()
            .compare_at_amount_per_quantity()
            .as_ref()
            .map(|compare_at| compare_at.amount().as_f64() > current_price)
            .unwrap_or(false);

        if is_sale_line {
            continue;
        }

        let is_map_restricted = match &line.merchandise() {
            schema::cart_lines_discounts_generate_run::input::cart::lines::Merchandise::ProductVariant(variant) => {
                let product = variant.product();
                let restricted_by_tag = *product.has_map_restricted_tag();
                let restricted_by_metafield = product
                    .map_restricted()
                    .as_ref()
                    .map(|metafield| metafield.value().eq_ignore_ascii_case("true"))
                    .unwrap_or(false);
                restricted_by_metafield || restricted_by_tag
            }
            _ => false,
        };

        if is_map_restricted {
            continue;
        }

        let message = if config.message.is_empty() {
            Some(format!("{}% off eligible regular-priced merchandise", config.percentage))
        } else {
            Some(config.message.clone())
        };

        candidates.push(schema::ProductDiscountCandidate {
            value: schema::ProductDiscountCandidateValue::Percentage(schema::Percentage {
                value: Decimal::from(config.percentage),
            }),
            targets: vec![schema::ProductDiscountCandidateTarget::CartLine(
                schema::CartLineTarget {
                    id: line.id().to_string(),
                    quantity: None,
                },
            )],
            message,
            associated_discount_code: None,
            prerequisites: None,
        });
    }

    if candidates.is_empty() {
        return Ok(schema::CartLinesDiscountsGenerateRunResult {
            operations: vec![],
        });
    }

    Ok(schema::CartLinesDiscountsGenerateRunResult {
        operations: vec![schema::CartOperation::ProductDiscountsAdd(
            schema::ProductDiscountsAddOperation {
                selection_strategy: schema::ProductDiscountSelectionStrategy::First,
                candidates,
            },
        )],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use shopify_function::{run_function_with_input, Result};

    #[test]
    fn excludes_sale_and_map_restricted_lines() -> Result<()> {
        let result = run_function_with_input(
            cart_lines_discounts_generate_run,
            include_str!("../tests/input.json"),
        )?;

        assert_eq!(result.operations.len(), 1);
        Ok(())
    }
}
