---
base_model: minishlab/potion-base-32M
datasets:
- sentence-transformers/gooaq
- sentence-transformers/msmarco-co-condenser-margin-mse-sym-mnrl-mean-v1
- sentence-transformers/squad
- sentence-transformers/s2orc
- sentence-transformers/all-nli
- sentence-transformers/paq
- sentence-transformers/trivia-qa
- bclavie/msmarco-10m-triplets
- nthakur/swim-ir-monolingual
- sentence-transformers/pubmedqa
- sentence-transformers/miracl
- sentence-transformers/mldr
- sentence-transformers/mr-tydi
library_name: model2vec
license: mit
model_name: potion-retrieval-32M
tags:
- embeddings
- static-embeddings
- sentence-transformers
base_model_relation: finetune
---



# potion-retrieval-32M Model Card

<div align="center">
  <img width="35%" alt="Model2Vec logo" src="https://raw.githubusercontent.com/MinishLab/model2vec/main/assets/images/logo_v2.png">
</div>


This Model2Vec model is optmized for retrieval tasks. It is a finetune of [potion-base-32M](https://huggingface.co/minishlab/potion-base-32M). It's finetuned using a modified version of the training approach described in [this blogpost](https://huggingface.co/blog/static-embeddings). It uses static embeddings, allowing text embeddings to be computed orders of magnitude faster on both GPU and CPU. It is designed for applications where computational resources are limited or where real-time performance is critical. 


## Installation

Install model2vec using pip:
```
pip install model2vec
```

## Usage
Load this model using the `from_pretrained` method:
```python
from model2vec import StaticModel
# Load a pretrained Model2Vec model
model = StaticModel.from_pretrained("minishlab/potion-retrieval-32M")
# Compute text embeddings
embeddings = model.encode(["Example sentence"])
```


## How it works

Model2vec creates a small, static model that outperforms other static embedding models by a large margin on all tasks on [MTEB](https://huggingface.co/spaces/mteb/leaderboard). This model is pre-trained using [Tokenlearn](https://github.com/MinishLab/tokenlearn). It's created using the following steps:
- Distillation: first, a model is distilled from a sentence transformer model using Model2Vec.
- Training data creation: the sentence transformer model is used to create training data by creating mean output embeddings on a large corpus.
- Training: the distilled model is trained on the training data using Tokenlearn.
- Post-training re-regularization: after training, the model is re-regularized by weighting the tokens based on their frequency, applying PCA, and finally applying [SIF weighting](https://openreview.net/pdf?id=SyK00v5xx).

The results for this model can be found on the [Model2Vec results page](https://github.com/MinishLab/model2vec/blob/main/results/README.md).



## Results

| Model | MTEB Retrieval Score |
|:---|---:|
| [all-MiniLM-L6-v2](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2) | 42.92 |
| **[potion-retrieval-32M](https://huggingface.co/minishlab/potion-retrieval-32M)** | **35.06** |
| [static-retrieval-mrl-en-v1](https://huggingface.co/minishlab/static-retrieval-mrl-en-v1) | 34.95 |
| [potion-base-32M](https://huggingface.co/minishlab/potion-base-32M) | 32.67 |

The results show that **potion-retrieval-32M** is the most performant static retrieval model, reaching 81.69% of the performance of [all-MiniLM-L6-v2](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2) with a retrieval score of 35.06 while being orders of magnitude faster.

For full results, see the [MTEB leaderboard](https://huggingface.co/spaces/mteb/leaderboard).

## Additional Resources

- [All Model2Vec models on the hub](https://huggingface.co/models?library=model2vec)
- [Model2Vec Repo](https://github.com/MinishLab/model2vec)
- [Tokenlearn repo](https://github.com/MinishLab/tokenlearn)
- [Model2Vec Results](https://github.com/MinishLab/model2vec/blob/main/results/README.md)
- [Model2Vec Tutorials](https://github.com/MinishLab/model2vec/tree/main/tutorials)

## Library Authors

Model2Vec was developed by the [Minish Lab](https://github.com/MinishLab) team consisting of [Stephan Tulkens](https://github.com/stephantul) and [Thomas van Dongen](https://github.com/Pringled).

## Citation

Please cite the [Model2Vec repository](https://github.com/MinishLab/model2vec) if you use this model in your work.
```bibtex
@software{minishlab2024model2vec,
  author       = {Stephan Tulkens and {van Dongen}, Thomas},
  title        = {Model2Vec: Fast State-of-the-Art Static Embeddings},
  year         = {2024},
  publisher    = {Zenodo},
  doi          = {10.5281/zenodo.17270888},
  url          = {https://github.com/MinishLab/model2vec},
  license      = {MIT}
}
```

## Reproducibility

The following script can be used to reproduce this model. All credits go to [Tom Aarsen](https://huggingface.co/tomaarsen) for this fine-tuning approach and code he introduced in his [blogpost](https://huggingface.co/blog/static-embeddings). We make a few modifcations to the original code, namely:

- We start with a pre-trained Model2Vec model ([potion-base-32M](https://huggingface.co/minishlab/potion-base-32M)).
- We reduce the dataset size by a factor of 10. During experiments we saw that we didn't need the full dataset for the model to converge.
- We decease the learning rate and train for 3 epochs instead of 1. Using a high learning rate wipes the effects of using a pre-trained model.

```python
import random
import logging
from datasets import load_dataset, Dataset, DatasetDict
from sentence_transformers import (
    SentenceTransformer,
    SentenceTransformerTrainer,
    SentenceTransformerTrainingArguments,
    SentenceTransformerModelCardData,
)
from sentence_transformers.losses import MatryoshkaLoss, MultipleNegativesRankingLoss
from sentence_transformers.training_args import BatchSamplers, MultiDatasetBatchSamplers
from sentence_transformers.evaluation import NanoBEIREvaluator
from sentence_transformers.models.StaticEmbedding import StaticEmbedding
import wandb

logging.basicConfig(
    format="%(asctime)s - %(message)s", datefmt="%Y-%m-%d %H:%M:%S", level=logging.INFO
)
random.seed(12)


def load_train_eval_datasets(factor: int = 1):
    """
    Loads train and eval datasets from disk if available. Otherwise, downloads 
    them from Hugging Face, preprocesses, and saves them to disk. If `factor` is 
    greater than 1, returns a fraction (1/factor) of each dataset subset.

    :param factor: The factor by which the data is reduced. If factor=1, no reduction is performed.
    :return: (train_dataset: DatasetDict, eval_dataset: DatasetDict)
    """
    try:
        # Try loading from disk
        train_dataset = DatasetDict.load_from_disk("datasets/train_dataset")
        eval_dataset = DatasetDict.load_from_disk("datasets/eval_dataset")
    except FileNotFoundError:
        print("Prebuilt datasets not found on disk. Building from scratch...")

        print("Loading gooaq dataset...")
        gooaq_dataset = load_dataset("sentence-transformers/gooaq", split="train")
        gooaq_dataset_dict = gooaq_dataset.train_test_split(test_size=10_000, seed=12)
        gooaq_train_dataset: Dataset = gooaq_dataset_dict["train"]
        gooaq_eval_dataset: Dataset = gooaq_dataset_dict["test"]
        print("Loaded gooaq dataset.")

        print("Loading msmarco dataset...")
        msmarco_dataset = load_dataset(
            "sentence-transformers/msmarco-co-condenser-margin-mse-sym-mnrl-mean-v1",
            "triplet",
            split="train"
        )
        msmarco_dataset_dict = msmarco_dataset.train_test_split(test_size=10_000, seed=12)
        msmarco_train_dataset: Dataset = msmarco_dataset_dict["train"]
        msmarco_eval_dataset: Dataset = msmarco_dataset_dict["test"]
        print("Loaded msmarco dataset.")

        print("Loading squad dataset...")
        squad_dataset = load_dataset("sentence-transformers/squad", split="train")
        squad_dataset_dict = squad_dataset.train_test_split(test_size=10_000, seed=12)
        squad_train_dataset: Dataset = squad_dataset_dict["train"]
        squad_eval_dataset: Dataset = squad_dataset_dict["test"]
        print("Loaded squad dataset.")

        print("Loading s2orc dataset...")
        s2orc_dataset = load_dataset(
            "sentence-transformers/s2orc", 
            "title-abstract-pair", 
            split="train[:100000]"  # limit to 100k
        )
        s2orc_dataset_dict = s2orc_dataset.train_test_split(test_size=10_000, seed=12)
        s2orc_train_dataset: Dataset = s2orc_dataset_dict["train"]
        s2orc_eval_dataset: Dataset = s2orc_dataset_dict["test"]
        print("Loaded s2orc dataset.")

        print("Loading allnli dataset...")
        allnli_train_dataset = load_dataset(
            "sentence-transformers/all-nli", 
            "triplet", 
            split="train"
        )
        allnli_eval_dataset = load_dataset(
            "sentence-transformers/all-nli", 
            "triplet", 
            split="dev"
        )
        print("Loaded allnli dataset.")

        print("Loading paq dataset...")
        paq_dataset = load_dataset("sentence-transformers/paq", split="train")
        paq_dataset_dict = paq_dataset.train_test_split(test_size=10_000, seed=12)
        paq_train_dataset: Dataset = paq_dataset_dict["train"]
        paq_eval_dataset: Dataset = paq_dataset_dict["test"]
        print("Loaded paq dataset.")

        print("Loading trivia_qa dataset...")
        trivia_qa = load_dataset("sentence-transformers/trivia-qa", split="train")
        trivia_qa_dataset_dict = trivia_qa.train_test_split(test_size=5_000, seed=12)
        trivia_qa_train_dataset: Dataset = trivia_qa_dataset_dict["train"]
        trivia_qa_eval_dataset: Dataset = trivia_qa_dataset_dict["test"]
        print("Loaded trivia_qa dataset.")

        print("Loading msmarco_10m dataset...")
        msmarco_10m_dataset = load_dataset("bclavie/msmarco-10m-triplets", split="train")
        msmarco_10m_dataset_dict = msmarco_10m_dataset.train_test_split(
            test_size=10_000, seed=12
        )
        msmarco_10m_train_dataset: Dataset = msmarco_10m_dataset_dict["train"]
        msmarco_10m_eval_dataset: Dataset = msmarco_10m_dataset_dict["test"]
        print("Loaded msmarco_10m dataset.")

        print("Loading swim_ir dataset...")
        swim_ir_dataset = load_dataset(
            "nthakur/swim-ir-monolingual", 
            "en", 
            split="train"
        ).select_columns(["query", "text"])
        swim_ir_dataset_dict = swim_ir_dataset.train_test_split(
            test_size=10_000, seed=12
        )
        swim_ir_train_dataset: Dataset = swim_ir_dataset_dict["train"]
        swim_ir_eval_dataset: Dataset = swim_ir_dataset_dict["test"]
        print("Loaded swim_ir dataset.")

        # NOTE: 20 negatives
        print("Loading pubmedqa dataset...")
        pubmedqa_dataset = load_dataset(
            "sentence-transformers/pubmedqa", 
            "triplet-20", 
            split="train"
        )
        pubmedqa_dataset_dict = pubmedqa_dataset.train_test_split(test_size=100, seed=12)
        pubmedqa_train_dataset: Dataset = pubmedqa_dataset_dict["train"]
        pubmedqa_eval_dataset: Dataset = pubmedqa_dataset_dict["test"]
        print("Loaded pubmedqa dataset.")

        # NOTE: A lot of overlap with anchor/positives
        print("Loading miracl dataset...")
        miracl_dataset = load_dataset(
            "sentence-transformers/miracl", 
            "en-triplet-all", 
            split="train"
        )
        miracl_dataset_dict = miracl_dataset.train_test_split(test_size=10_000, seed=12)
        miracl_train_dataset: Dataset = miracl_dataset_dict["train"]
        miracl_eval_dataset: Dataset = miracl_dataset_dict["test"]
        print("Loaded miracl dataset.")

        # NOTE: A lot of overlap with anchor/positives
        print("Loading mldr dataset...")
        mldr_dataset = load_dataset(
            "sentence-transformers/mldr", 
            "en-triplet-all", 
            split="train"
        )
        mldr_dataset_dict = mldr_dataset.train_test_split(test_size=10_000, seed=12)
        mldr_train_dataset: Dataset = mldr_dataset_dict["train"]
        mldr_eval_dataset: Dataset = mldr_dataset_dict["test"]
        print("Loaded mldr dataset.")

        # NOTE: A lot of overlap with anchor/positives
        print("Loading mr_tydi dataset...")
        mr_tydi_dataset = load_dataset(
            "sentence-transformers/mr-tydi", 
            "en-triplet-all", 
            split="train"
        )
        mr_tydi_dataset_dict = mr_tydi_dataset.train_test_split(test_size=10_000, seed=12)
        mr_tydi_train_dataset: Dataset = mr_tydi_dataset_dict["train"]
        mr_tydi_eval_dataset: Dataset = mr_tydi_dataset_dict["test"]
        print("Loaded mr_tydi dataset.")

        train_dataset = DatasetDict({
            "gooaq": gooaq_train_dataset,
            "msmarco": msmarco_train_dataset,
            "squad": squad_train_dataset,
            "s2orc": s2orc_train_dataset,
            "allnli": allnli_train_dataset,
            "paq": paq_train_dataset,
            "trivia_qa": trivia_qa_train_dataset,
            "msmarco_10m": msmarco_10m_train_dataset,
            "swim_ir": swim_ir_train_dataset,
            "pubmedqa": pubmedqa_train_dataset,
            "miracl": miracl_train_dataset,
            "mldr": mldr_train_dataset,
            "mr_tydi": mr_tydi_train_dataset,
        })
        eval_dataset = DatasetDict({
            "gooaq": gooaq_eval_dataset,
            "msmarco": msmarco_eval_dataset,
            "squad": squad_eval_dataset,
            "s2orc": s2orc_eval_dataset,
            "allnli": allnli_eval_dataset,
            "paq": paq_eval_dataset,
            "trivia_qa": trivia_qa_eval_dataset,
            "msmarco_10m": msmarco_10m_eval_dataset,
            "swim_ir": swim_ir_eval_dataset,
            "pubmedqa": pubmedqa_eval_dataset,
            "miracl": miracl_eval_dataset,
            "mldr": mldr_eval_dataset,
            "mr_tydi": mr_tydi_eval_dataset,
        })

        # Save to disk for next time
        train_dataset.save_to_disk("datasets/train_dataset")
        eval_dataset.save_to_disk("datasets/eval_dataset")

        # Quit to avoid memory overhead on large datasets
        quit()

    # Reduce the dataset if factor > 1
    if factor > 1:
        for subset_name in train_dataset:
            ds = train_dataset[subset_name].shuffle(seed=42)
            new_len = len(ds) // factor
            train_dataset[subset_name] = ds.select(range(new_len))

        for subset_name in eval_dataset:
            ds = eval_dataset[subset_name].shuffle(seed=42)
            new_len = len(ds) // factor
            eval_dataset[subset_name] = ds.select(range(new_len))

    return train_dataset, eval_dataset


def main():
    wandb.init(entity="minishlab", project="minishlab")
    # 1. Load a model to finetune
    static_embedding = StaticEmbedding.from_model2vec("minishlab/potion-base-32M")

    # 2. Initialize the SentenceTransformer model
    model_name = "potion-retrieval-32M"
    model = SentenceTransformer(
        modules=[static_embedding],
        model_card_data=SentenceTransformerModelCardData(
            language="en",
            license="MIT",
            model_name=model_name,
        ),
    )

    # 3. Load training & evaluation datasets
    # NOTE: we reduce the total dataset size by a factor of 10 
    train_dataset, eval_dataset = load_train_eval_datasets(factor=10)
    print(train_dataset)

    # 4. Define a loss function
    loss = MultipleNegativesRankingLoss(model)
    loss = MatryoshkaLoss(model, loss, matryoshka_dims=[32, 64, 128, 256, 512])

    # 5. Specify training arguments
    run_name = model_name
    epochs = 3
    lr = 0.05
    args = SentenceTransformerTrainingArguments(
        output_dir=f"models/{run_name}",
        num_train_epochs=epochs,
        per_device_train_batch_size=2048,
        per_device_eval_batch_size=2048,
        learning_rate=lr,
        warmup_ratio=0.1,
        fp16=False,
        bf16=True,
        batch_sampler=BatchSamplers.NO_DUPLICATES,
        multi_dataset_batch_sampler=MultiDatasetBatchSamplers.PROPORTIONAL,
        eval_strategy="steps",
        eval_steps=250,
        save_strategy="steps",
        save_steps=250,
        save_total_limit=2,
        logging_steps=250,
        logging_first_step=True,
        run_name=run_name,
        report_to=["wandb"],
        load_best_model_at_end=True,
        metric_for_best_model="eval_NanoBEIR_mean_cosine_ndcg@10",
        greater_is_better=True,
    )

    # 6. Create an evaluator & evaluate the base model
    evaluator = NanoBEIREvaluator()
    evaluator(model)

    # 7. Create a trainer & train
    trainer = SentenceTransformerTrainer(
        model=model,
        args=args,
        train_dataset=train_dataset,
        eval_dataset=eval_dataset,
        loss=loss,
        evaluator=evaluator,
    )
    trainer.train()

    # 8. Evaluate the trained model and save
    evaluator(model)
    model.save_pretrained(f"models/{run_name}/final")


if __name__ == "__main__":
    main()
```